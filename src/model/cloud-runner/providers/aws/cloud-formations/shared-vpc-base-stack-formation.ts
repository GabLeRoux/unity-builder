export class SharedVpcBaseStackFormation {
  public static readonly baseStackDecription = `Game-CI base stack with optional shared VPC`;
  public static readonly formation: string = `AWSTemplateFormatVersion: '2010-09-09'
Description: ${SharedVpcBaseStackFormation.baseStackDecription}
Parameters:
  EnvironmentName:
    Type: String
    Default: development
    Description: 'Your deployment environment: DEV, QA , PROD'
  Version:
    Type: String
    Description: 'hash of template'
  SharedVpcId:
    Type: String
    Default: ''
    Description: 'Optional: ID of existing VPC to use instead of creating new one'
  SharedSubnetOne:
    Type: String
    Default: ''
    Description: 'Optional: ID of first subnet if using shared VPC'
  SharedSubnetTwo:
    Type: String
    Default: ''
    Description: 'Optional: ID of second subnet if using shared VPC'
  SharedSecurityGroup:
    Type: String
    Default: ''
    Description: 'Optional: ID of security group if using shared VPC'

Conditions:
  CreateVPC: !Equals [!Ref SharedVpcId, '']
  UseSharedVPC: !Not [!Equals [!Ref SharedVpcId, '']]

Mappings:
  SubnetConfig:
    VPC:
      CIDR: '10.0.0.0/16'
    PublicOne:
      CIDR: '10.0.0.0/24'
    PublicTwo:
      CIDR: '10.0.1.0/24'

Resources:
  # VPC - only created if SharedVpcId is not provided
  VPC:
    Type: AWS::EC2::VPC
    Condition: CreateVPC
    Properties:
      EnableDnsSupport: true
      EnableDnsHostnames: true
      CidrBlock: !FindInMap ['SubnetConfig', 'VPC', 'CIDR']

  MainBucket:
    Type: "AWS::S3::Bucket"
    Properties:
      BucketName: !Ref EnvironmentName

  EFSServerSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupName: !Sub '\${EnvironmentName}-efs-server-endpoints'
      GroupDescription: Which client ip addrs are allowed to access EFS server
      VpcId: !If [UseSharedVPC, !Ref SharedVpcId, !Ref VPC]
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 2049
          ToPort: 2049
          SourceSecurityGroupId: !If [UseSharedVPC, !Ref SharedSecurityGroup, !Ref ContainerSecurityGroup]

  ContainerSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Condition: CreateVPC
    Properties:
      GroupName: !Sub '\${EnvironmentName}-task-security-group'
      GroupDescription: Access to the Fargate containers
      VpcId: !Ref 'VPC'
      SecurityGroupEgress:
        - IpProtocol: -1
          FromPort: 2049
          ToPort: 2049
          CidrIp: '0.0.0.0/0'

  PublicSubnetOne:
    Type: AWS::EC2::Subnet
    Condition: CreateVPC
    Properties:
      AvailabilityZone: !Select
        - 0
        - Fn::GetAZs: !Ref 'AWS::Region'
      VpcId: !Ref 'VPC'
      CidrBlock: !FindInMap ['SubnetConfig', 'PublicOne', 'CIDR']

  PublicSubnetTwo:
    Type: AWS::EC2::Subnet
    Condition: CreateVPC
    Properties:
      AvailabilityZone: !Select
        - 1
        - Fn::GetAZs: !Ref 'AWS::Region'
      VpcId: !Ref 'VPC'
      CidrBlock: !FindInMap ['SubnetConfig', 'PublicTwo', 'CIDR']

  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Condition: CreateVPC

  GatewayAttachement:
    Type: AWS::EC2::VPCGatewayAttachment
    Condition: CreateVPC
    Properties:
      VpcId: !Ref 'VPC'
      InternetGatewayId: !Ref 'InternetGateway'

  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Condition: CreateVPC
    Properties:
      VpcId: !Ref 'VPC'

  PublicRoute:
    Type: AWS::EC2::Route
    Condition: CreateVPC
    DependsOn: GatewayAttachement
    Properties:
      RouteTableId: !Ref 'PublicRouteTable'
      DestinationCidrBlock: '0.0.0.0/0'
      GatewayId: !Ref 'InternetGateway'

  PublicSubnetOneRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Condition: CreateVPC
    Properties:
      SubnetId: !Ref PublicSubnetOne
      RouteTableId: !Ref PublicRouteTable

  PublicSubnetTwoRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Condition: CreateVPC
    Properties:
      SubnetId: !Ref PublicSubnetTwo
      RouteTableId: !Ref PublicRouteTable

  ECSCluster:
    Type: AWS::ECS::Cluster

  AutoscalingRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: [application-autoscaling.amazonaws.com]
            Action: ['sts:AssumeRole']
      Path: /
      Policies:
        - PolicyName: service-autoscaling
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action:
                  - 'application-autoscaling:*'
                  - 'cloudwatch:DescribeAlarms'
                  - 'cloudwatch:PutMetricAlarm'
                  - 'ecs:DescribeServices'
                  - 'ecs:UpdateService'
                Resource: '*'

  ECSRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: [ecs.amazonaws.com]
            Action: ['sts:AssumeRole']
      Path: /
      Policies:
        - PolicyName: ecs-service
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action:
                  - 'ec2:AttachNetworkInterface'
                  - 'ec2:CreateNetworkInterface'
                  - 'ec2:CreateNetworkInterfacePermission'
                  - 'ec2:DeleteNetworkInterface'
                  - 'ec2:DeleteNetworkInterfacePermission'
                  - 'ec2:Describe*'
                  - 'ec2:DetachNetworkInterface'
                  - 'elasticloadbalancing:DeregisterInstancesFromLoadBalancer'
                  - 'elasticloadbalancing:DeregisterTargets'
                  - 'elasticloadbalancing:Describe*'
                  - 'elasticloadbalancing:RegisterInstancesWithLoadBalancer'
                  - 'elasticloadbalancing:RegisterTargets'
                Resource: '*'

  ECSTaskExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: [ecs-tasks.amazonaws.com]
            Action: ['sts:AssumeRole']
      Path: /
      Policies:
        - PolicyName: AmazonECSTaskExecutionRolePolicy
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action:
                  - 'secretsmanager:GetSecretValue'
                  - 'kms:Decrypt'
                  - 'ecr:GetAuthorizationToken'
                  - 'ecr:BatchCheckLayerAvailability'
                  - 'ecr:GetDownloadUrlForLayer'
                  - 'ecr:BatchGetImage'
                  - 'logs:CreateLogStream'
                  - 'logs:PutLogEvents'
                Resource: '*'

  DeleteCFNLambdaExecutionRole:
    Type: 'AWS::IAM::Role'
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: 'Allow'
            Principal:
              Service: ['lambda.amazonaws.com']
            Action: 'sts:AssumeRole'
      Path: '/'
      Policies:
        - PolicyName: DeleteCFNLambdaExecutionRole
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: 'Allow'
                Action:
                  - 'logs:CreateLogGroup'
                  - 'logs:CreateLogStream'
                  - 'logs:PutLogEvents'
                Resource: 'arn:aws:logs:*:*:*'
              - Effect: 'Allow'
                Action:
                  - 'cloudformation:DeleteStack'
                  - 'kinesis:DeleteStream'
                  - 'secretsmanager:DeleteSecret'
                  - 'kinesis:DescribeStreamSummary'
                  - 'logs:DeleteLogGroup'
                  - 'logs:DeleteSubscriptionFilter'
                  - 'ecs:DeregisterTaskDefinition'
                  - 'lambda:DeleteFunction'
                  - 'lambda:InvokeFunction'
                  - 'events:RemoveTargets'
                  - 'events:DeleteRule'
                  - 'lambda:RemovePermission'
                Resource: '*'

  CloudWatchIAMRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: [logs.amazonaws.com]
            Action: ['sts:AssumeRole']
      Path: /
      Policies:
        - PolicyName: service-autoscaling
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action:
                  - 'kinesis:PutRecord'
                Resource: '*'

  EfsFileStorage:
    Type: 'AWS::EFS::FileSystem'
    Properties:
      BackupPolicy:
        Status: ENABLED
      PerformanceMode: maxIO
      Encrypted: false
      FileSystemPolicy:
        Version: '2012-10-17'
        Statement:
          - Effect: 'Allow'
            Action:
              - 'elasticfilesystem:ClientMount'
              - 'elasticfilesystem:ClientWrite'
              - 'elasticfilesystem:ClientRootAccess'
            Principal:
              AWS: '*'

  MountTargetResource1:
    Type: AWS::EFS::MountTarget
    Properties:
      FileSystemId: !Ref EfsFileStorage
      SubnetId: !If [UseSharedVPC, !Ref SharedSubnetOne, !Ref PublicSubnetOne]
      SecurityGroups:
        - !Ref EFSServerSecurityGroup

  MountTargetResource2:
    Type: AWS::EFS::MountTarget
    Properties:
      FileSystemId: !Ref EfsFileStorage
      SubnetId: !If [UseSharedVPC, !Ref SharedSubnetTwo, !Ref PublicSubnetTwo]
      SecurityGroups:
        - !Ref EFSServerSecurityGroup

Outputs:
  EfsFileStorageId:
    Description: 'The connection endpoint for the database.'
    Value: !Ref EfsFileStorage
    Export:
      Name: !Sub '\${EnvironmentName}:EfsFileStorageId'
  ClusterName:
    Description: The name of the ECS cluster
    Value: !Ref 'ECSCluster'
    Export:
      Name: !Sub '\${EnvironmentName}:ClusterName'
  AutoscalingRole:
    Description: The ARN of the role used for autoscaling
    Value: !GetAtt 'AutoscalingRole.Arn'
    Export:
      Name: !Sub '\${EnvironmentName}:AutoscalingRole'
  ECSRole:
    Description: The ARN of the ECS role
    Value: !GetAtt 'ECSRole.Arn'
    Export:
      Name: !Sub '\${EnvironmentName}:ECSRole'
  ECSTaskExecutionRole:
    Description: The ARN of the ECS role tsk execution role
    Value: !GetAtt 'ECSTaskExecutionRole.Arn'
    Export:
      Name: !Sub '\${EnvironmentName}:ECSTaskExecutionRole'
  DeleteCFNLambdaExecutionRole:
    Description: Lambda execution role for cleaning up cloud formations
    Value: !GetAtt 'DeleteCFNLambdaExecutionRole.Arn'
    Export:
      Name: !Sub '\${EnvironmentName}:DeleteCFNLambdaExecutionRole'
  CloudWatchIAMRole:
    Description: The ARN of the CloudWatch role for subscription filter
    Value: !GetAtt 'CloudWatchIAMRole.Arn'
    Export:
      Name: !Sub '\${EnvironmentName}:CloudWatchIAMRole'
  VpcId:
    Description: The ID of the VPC that this stack is deployed in
    Value: !If [UseSharedVPC, !Ref SharedVpcId, !Ref VPC]
    Export:
      Name: !Sub '\${EnvironmentName}:VpcId'
  PublicSubnetOne:
    Description: Public subnet one
    Value: !If [UseSharedVPC, !Ref SharedSubnetOne, !Ref PublicSubnetOne]
    Export:
      Name: !Sub '\${EnvironmentName}:PublicSubnetOne'
  PublicSubnetTwo:
    Description: Public subnet two
    Value: !If [UseSharedVPC, !Ref SharedSubnetTwo, !Ref PublicSubnetTwo]
    Export:
      Name: !Sub '\${EnvironmentName}:PublicSubnetTwo'
  ContainerSecurityGroup:
    Description: A security group used to allow Fargate containers to receive traffic
    Value: !If [UseSharedVPC, !Ref SharedSecurityGroup, !Ref ContainerSecurityGroup]
    Export:
      Name: !Sub '\${EnvironmentName}:ContainerSecurityGroup'
`;
}
