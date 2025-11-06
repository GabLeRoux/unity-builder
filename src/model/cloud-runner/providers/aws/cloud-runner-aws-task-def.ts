import { Output, StackResource } from '@aws-sdk/client-cloudformation';

class CloudRunnerAWSTaskDef {
  public taskDefStackName!: string;
  public baseStackName!: string;
  public taskDefCloudFormation!: string;
  public taskDefResources: StackResource[] | undefined;
  public baseResources: StackResource[] | undefined;
  public baseOutputs: Output[] | undefined;
}
export default CloudRunnerAWSTaskDef;
