import { DescribeTasksCommand, RunTaskCommand, waitUntilTasksRunning } from '@aws-sdk/client-ecs';
import { DescribeStreamCommand, GetRecordsCommand, GetShardIteratorCommand } from '@aws-sdk/client-kinesis';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import CloudRunnerEnvironmentVariable from '../../options/cloud-runner-environment-variable';
import * as core from '@actions/core';
import CloudRunnerAWSTaskDef from './cloud-runner-aws-task-def';
import * as zlib from 'node:zlib';
import CloudRunnerLogger from '../../services/core/cloud-runner-logger';
import { Input } from '../../..';
import CloudRunner from '../../cloud-runner';
import { CommandHookService } from '../../services/hooks/command-hook-service';
import { FollowLogStreamService } from '../../services/core/follow-log-stream-service';
import CloudRunnerOptions from '../../options/cloud-runner-options';
import GitHub from '../../../github';
import { AwsClientFactory } from './aws-client-factory';

class AWSTaskRunner {
  private static readonly encodedUnderscore = `$252F`;

  private static async uploadCommandToS3(commands: string, stackName: string, baseStackName: string): Promise<string> {
    // Use base stack name as bucket name (created by CloudFormation)
    const bucketName = baseStackName.toLowerCase();
    const key = `commands/${stackName}-${Date.now()}.sh`;

    try {
      // Try to upload to S3
      await AwsClientFactory.getS3().send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: commands,
          ContentType: 'text/plain',
        }),
      );

      const s3Url = `s3://${bucketName}/${key}`;
      CloudRunnerLogger.log(`Uploaded command script to ${s3Url}`);
      return s3Url;
    } catch (error: any) {
      // If bucket doesn't exist, it means CloudFormation hasn't created it yet
      if (error.name === 'NoSuchBucket') {
        CloudRunnerLogger.log(`S3 bucket ${bucketName} does not exist yet (CloudFormation may still be creating it)`);
        CloudRunnerLogger.log(`Waiting 10 seconds and retrying...`);
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Retry once
        try {
          await AwsClientFactory.getS3().send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: commands,
              ContentType: 'text/plain',
            }),
          );
          const s3Url = `s3://${bucketName}/${key}`;
          CloudRunnerLogger.log(`Uploaded command script to ${s3Url}`);
          return s3Url;
        } catch (retryError) {
          CloudRunnerLogger.log(`Failed to upload command to S3 after retry: ${retryError}`);
          throw retryError;
        }
      }

      CloudRunnerLogger.log(`Failed to upload command to S3: ${error}`);
      throw error;
    }
  }

  static async runTask(
    taskDef: CloudRunnerAWSTaskDef,
    environment: CloudRunnerEnvironmentVariable[],
    commands: string,
  ): Promise<{ output: string; shouldCleanup: boolean }> {
    const cluster = taskDef.baseResources?.find((x) => x.LogicalResourceId === 'ECSCluster')?.PhysicalResourceId || '';
    const taskDefinition =
      taskDef.taskDefResources?.find((x) => x.LogicalResourceId === 'TaskDefinition')?.PhysicalResourceId || '';

    // Try to get subnets from resources first, then fall back to outputs (for shared VPC)
    const SubnetOne =
      taskDef.baseResources?.find((x) => x.LogicalResourceId === 'PublicSubnetOne')?.PhysicalResourceId ||
      taskDef.baseOutputs?.find((x) => x.OutputKey === 'PublicSubnetOne')?.OutputValue ||
      '';
    const SubnetTwo =
      taskDef.baseResources?.find((x) => x.LogicalResourceId === 'PublicSubnetTwo')?.PhysicalResourceId ||
      taskDef.baseOutputs?.find((x) => x.OutputKey === 'PublicSubnetTwo')?.OutputValue ||
      '';
    const ContainerSecurityGroup =
      taskDef.baseResources?.find((x) => x.LogicalResourceId === 'ContainerSecurityGroup')?.PhysicalResourceId ||
      taskDef.baseOutputs?.find((x) => x.OutputKey === 'ContainerSecurityGroup')?.OutputValue ||
      '';
    const streamName =
      taskDef.taskDefResources?.find((x) => x.LogicalResourceId === 'KinesisStream')?.PhysicalResourceId || '';

    const fullCommand = CommandHookService.ApplyHooksToCommands(commands, CloudRunner.buildParameters);

    // Check if command would exceed AWS limit
    let finalCommand = fullCommand;
    const testOverrides = {
      containerOverrides: [
        {
          name: taskDef.taskDefStackName,
          environment,
          command: ['-c', fullCommand],
        },
      ],
    };

    const overridesSize = JSON.stringify(testOverrides).length;
    CloudRunnerLogger.log(`Container overrides size: ${overridesSize} / 8192`);

    if (overridesSize > 8192) {
      CloudRunnerLogger.log('Command too large, uploading to S3...');
      const s3Url = await this.uploadCommandToS3(fullCommand, taskDef.taskDefStackName, taskDef.baseStackName || CloudRunner.buildParameters.awsStackName);

      // Install AWS CLI and download script (AWS CLI not pre-installed in Unity containers)
      // Use Python pip method which is more reliable in Unity containers
      finalCommand = `
        set -e
        echo "[Cloud-Runner] Installing AWS CLI..."

        # Try apt-get first (fastest if available)
        if apt-get update -qq 2>/dev/null && apt-get install -y -qq awscli 2>/dev/null; then
          echo "[Cloud-Runner] AWS CLI installed via apt-get"
          # Refresh PATH to pick up newly installed aws command
          export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
          hash -r
        # Try pip if Python is available
        elif command -v pip3 &> /dev/null; then
          echo "[Cloud-Runner] Installing AWS CLI via pip3..."
          pip3 install --quiet awscli
          echo "[Cloud-Runner] AWS CLI installed via pip3"
          # Add pip install location to PATH
          export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
          hash -r
        elif command -v pip &> /dev/null; then
          echo "[Cloud-Runner] Installing AWS CLI via pip..."
          pip install --quiet awscli
          echo "[Cloud-Runner] AWS CLI installed via pip"
          # Add pip install location to PATH
          export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
          hash -r
        # Last resort: download and install manually
        else
          echo "[Cloud-Runner] Installing AWS CLI manually..."
          apt-get update -qq && apt-get install -y -qq curl unzip 2>/dev/null || true
          curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
          unzip -q /tmp/awscliv2.zip -d /tmp
          /tmp/aws/install
          echo "[Cloud-Runner] AWS CLI installed manually"
          export PATH="/usr/local/bin:$PATH"
          hash -r
        fi

        # Verify AWS CLI is available (check multiple possible locations)
        AWS_CMD=""
        if command -v aws &> /dev/null; then
          AWS_CMD="aws"
        elif [ -f /usr/local/bin/aws ]; then
          AWS_CMD="/usr/local/bin/aws"
        elif [ -f /usr/bin/aws ]; then
          AWS_CMD="/usr/bin/aws"
        elif [ -f $HOME/.local/bin/aws ]; then
          AWS_CMD="$HOME/.local/bin/aws"
        else
          echo "[Cloud-Runner] ERROR: AWS CLI installation failed - command not found"
          echo "[Cloud-Runner] PATH: $PATH"
          echo "[Cloud-Runner] Checking common locations:"
          ls -la /usr/local/bin/aws 2>&1 || echo "  /usr/local/bin/aws not found"
          ls -la /usr/bin/aws 2>&1 || echo "  /usr/bin/aws not found"
          exit 1
        fi

        echo "[Cloud-Runner] AWS CLI found at: $AWS_CMD"
        echo "[Cloud-Runner] AWS CLI version: $($AWS_CMD --version)"
        echo "[Cloud-Runner] Downloading command script from S3..."
        $AWS_CMD s3 cp ${s3Url} /tmp/command.sh
        chmod +x /tmp/command.sh
        echo "[Cloud-Runner] Executing command script..."
        /bin/sh /tmp/command.sh
      `;
    }

    const runParameters = {
      cluster,
      taskDefinition,
      platformVersion: '1.4.0',
      overrides: {
        containerOverrides: [
          {
            name: taskDef.taskDefStackName,
            environment,
            command: ['-c', finalCommand],
          },
        ],
      },
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [SubnetOne, SubnetTwo],
          assignPublicIp: 'ENABLED',
          securityGroups: [ContainerSecurityGroup],
        },
      },
    };

    const finalOverridesSize = JSON.stringify(runParameters.overrides.containerOverrides).length;
    if (finalOverridesSize > 8192) {
      CloudRunnerLogger.log(JSON.stringify(runParameters.overrides.containerOverrides, undefined, 4));
      throw new Error(`Container Overrides length must be at most 8192 (actual: ${finalOverridesSize})`);
    }

    CloudRunnerLogger.log(`Final container overrides size: ${finalOverridesSize} / 8192`);

    const task = await AwsClientFactory.getECS().send(new RunTaskCommand(runParameters as any));
    const taskArn = task.tasks?.[0].taskArn || '';
    CloudRunnerLogger.log('Cloud runner job is starting');
    await AWSTaskRunner.waitUntilTaskRunning(taskArn, cluster);
    CloudRunnerLogger.log(
      `Cloud runner job status is running ${(await AWSTaskRunner.describeTasks(cluster, taskArn))?.lastStatus} Async:${
        CloudRunnerOptions.asyncCloudRunner
      }`,
    );
    if (CloudRunnerOptions.asyncCloudRunner) {
      const shouldCleanup: boolean = false;
      const output: string = '';
      CloudRunnerLogger.log(`Watch Cloud Runner To End: false`);

      return { output, shouldCleanup };
    }

    CloudRunnerLogger.log(`Streaming...`);
    const { output, shouldCleanup } = await this.streamLogsUntilTaskStops(cluster, taskArn, streamName);
    let exitCode;
    let containerState;
    let taskData;
    while (exitCode === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      taskData = await AWSTaskRunner.describeTasks(cluster, taskArn);
      const containers = taskData?.containers as any[] | undefined;
      if (!containers || containers.length === 0) {
        continue;
      }
      containerState = containers[0];
      exitCode = containerState?.exitCode;
    }
    CloudRunnerLogger.log(`Container State: ${JSON.stringify(containerState, undefined, 4)}`);
    if (exitCode === undefined) {
      CloudRunnerLogger.logWarning(`Undefined exitcode for container`);
    }
    const wasSuccessful = exitCode === 0;
    if (wasSuccessful) {
      CloudRunnerLogger.log(`Cloud runner job has finished successfully`);

      return { output, shouldCleanup };
    }

    if (taskData?.stoppedReason === 'Essential container in task exited' && exitCode === 1) {
      throw new Error('Container exited with code 1');
    }

    throw new Error(`Task failed`);
  }

  private static async waitUntilTaskRunning(taskArn: string, cluster: string) {
    try {
      await waitUntilTasksRunning(
        {
          client: AwsClientFactory.getECS(),
          maxWaitTime: 300,
          minDelay: 5,
          maxDelay: 30,
        },
        { tasks: [taskArn], cluster },
      );
    } catch (error_) {
      const error = error_ as Error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const taskAfterError = await AWSTaskRunner.describeTasks(cluster, taskArn);
      CloudRunnerLogger.log(`Cloud runner job has ended ${taskAfterError?.containers?.[0]?.lastStatus}`);

      core.setFailed(error);
      core.error(error);
    }
  }

  static async describeTasks(clusterName: string, taskArn: string) {
    const maxAttempts = 10;
    let delayMs = 1000;
    const maxDelayMs = 60000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tasks = await AwsClientFactory.getECS().send(
          new DescribeTasksCommand({ cluster: clusterName, tasks: [taskArn] }),
        );
        if (tasks.tasks?.[0]) {
          return tasks.tasks?.[0];
        }
        throw new Error('No task found');
      } catch (error: any) {
        const isThrottle = error?.name === 'ThrottlingException' || /rate exceeded/i.test(String(error?.message));
        if (!isThrottle || attempt === maxAttempts) {
          throw error;
        }
        const jitterMs = Math.floor(Math.random() * Math.min(1000, delayMs));
        const sleepMs = delayMs + jitterMs;
        CloudRunnerLogger.log(
          `AWS throttled DescribeTasks (attempt ${attempt}/${maxAttempts}), backing off ${sleepMs}ms (${delayMs} + jitter ${jitterMs})`,
        );
        await new Promise((r) => setTimeout(r, sleepMs));
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
    }
  }

  static async streamLogsUntilTaskStops(clusterName: string, taskArn: string, kinesisStreamName: string) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    CloudRunnerLogger.log(`Streaming...`);
    const stream = await AWSTaskRunner.getLogStream(kinesisStreamName);
    let iterator = await AWSTaskRunner.getLogIterator(stream);

    const logBaseUrl = `https://${Input.region}.console.aws.amazon.com/cloudwatch/home?region=${Input.region}#logsV2:log-groups/log-group/${CloudRunner.buildParameters.awsStackName}${AWSTaskRunner.encodedUnderscore}${CloudRunner.buildParameters.awsStackName}-${CloudRunner.buildParameters.buildGuid}`;
    CloudRunnerLogger.log(`You view the log stream on AWS Cloud Watch: ${logBaseUrl}`);
    await GitHub.updateGitHubCheck(`You view the log stream on AWS Cloud Watch:  ${logBaseUrl}`, ``);
    let shouldReadLogs = true;
    let shouldCleanup = true;
    let timestamp: number = 0;
    let output = '';
    while (shouldReadLogs) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const taskData = await AWSTaskRunner.describeTasks(clusterName, taskArn);
      ({ timestamp, shouldReadLogs } = AWSTaskRunner.checkStreamingShouldContinue(taskData, timestamp, shouldReadLogs));
      if (taskData?.lastStatus !== 'RUNNING') {
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }
      ({ iterator, shouldReadLogs, output, shouldCleanup } = await AWSTaskRunner.handleLogStreamIteration(
        iterator,
        shouldReadLogs,
        output,
        shouldCleanup,
      ));
    }

    return { output, shouldCleanup };
  }

  private static async handleLogStreamIteration(
    iterator: string,
    shouldReadLogs: boolean,
    output: string,
    shouldCleanup: boolean,
  ) {
    let records: any;
    try {
      records = await AwsClientFactory.getKinesis().send(new GetRecordsCommand({ ShardIterator: iterator }));
    } catch (error: any) {
      const isThrottle = error?.name === 'ThrottlingException' || /rate exceeded/i.test(String(error?.message));
      if (isThrottle) {
        const baseBackoffMs = 1000;
        const jitterMs = Math.floor(Math.random() * 1000);
        const sleepMs = baseBackoffMs + jitterMs;
        CloudRunnerLogger.log(`AWS throttled GetRecords, backing off ${sleepMs}ms (1000 + jitter ${jitterMs})`);
        await new Promise((r) => setTimeout(r, sleepMs));
        return { iterator, shouldReadLogs, output, shouldCleanup };
      }
      throw error;
    }
    iterator = records.NextShardIterator || '';
    ({ shouldReadLogs, output, shouldCleanup } = AWSTaskRunner.logRecords(
      records,
      iterator,
      shouldReadLogs,
      output,
      shouldCleanup,
    ));

    return { iterator, shouldReadLogs, output, shouldCleanup };
  }

  private static checkStreamingShouldContinue(taskData: any, timestamp: number, shouldReadLogs: boolean) {
    if (taskData?.lastStatus === 'UNKNOWN') {
      CloudRunnerLogger.log('## Cloud runner job unknwon');
    }
    if (taskData?.lastStatus !== 'RUNNING') {
      if (timestamp === 0) {
        CloudRunnerLogger.log('## Cloud runner job stopped, streaming end of logs');
        timestamp = Date.now();
      }
      if (timestamp !== 0 && Date.now() - timestamp > 30000) {
        CloudRunnerLogger.log('## Cloud runner status is not RUNNING for 30 seconds, last query for logs');
        shouldReadLogs = false;
      }
      CloudRunnerLogger.log(`## Status of job: ${taskData.lastStatus}`);
    }

    return { timestamp, shouldReadLogs };
  }

  private static logRecords(
    records: any,
    iterator: string,
    shouldReadLogs: boolean,
    output: string,
    shouldCleanup: boolean,
  ) {
    if ((records.Records ?? []).length > 0 && iterator) {
      for (const record of records.Records ?? []) {
        const json = JSON.parse(
          zlib.gunzipSync(Buffer.from(record.Data as unknown as string, 'base64')).toString('utf8'),
        );
        if (json.messageType === 'DATA_MESSAGE') {
          for (const logEvent of json.logEvents) {
            ({ shouldReadLogs, shouldCleanup, output } = FollowLogStreamService.handleIteration(
              logEvent.message,
              shouldReadLogs,
              shouldCleanup,
              output,
            ));
          }
        }
      }
    }

    return { shouldReadLogs, output, shouldCleanup };
  }

  private static async getLogStream(kinesisStreamName: string) {
    return await AwsClientFactory.getKinesis().send(new DescribeStreamCommand({ StreamName: kinesisStreamName }));
  }

  private static async getLogIterator(stream: any) {
    return (
      (
        await AwsClientFactory.getKinesis().send(
          new GetShardIteratorCommand({
            ShardIteratorType: 'TRIM_HORIZON',
            StreamName: stream.StreamDescription?.StreamName ?? '',
            ShardId: stream.StreamDescription?.Shards?.[0]?.ShardId || '',
          }),
        )
      ).ShardIterator || ''
    );
  }
}
export default AWSTaskRunner;
