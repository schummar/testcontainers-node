import { log } from "../../../logger";
import { DockerImageName } from "../../../docker-image-name";
import { dockerode } from "../../dockerode";
import Dockerode, { PortMap as DockerodePortBindings } from "dockerode";
import { Port, PortString } from "../../../port";
import { createLabels } from "../create-labels";
import { BindMount, Command, ContainerName, Env, ExtraHost, HealthCheck, NetworkMode, TmpFs } from "../../types";

export type CreateContainerOptions = {
  imageName: DockerImageName;
  env: Env;
  cmd: Command[];
  bindMounts: BindMount[];
  tmpFs: TmpFs;
  exposedPorts: Port[];
  name?: ContainerName;
  networkMode?: NetworkMode;
  healthCheck?: HealthCheck;
  useDefaultLogDriver: boolean;
  privilegedMode: boolean;
  autoRemove: boolean;
  extraHosts: ExtraHost[];
  ipcMode?: string;
  user?: string;
};

export const createContainer = async (options: CreateContainerOptions): Promise<Dockerode.Container> => {
  try {
    log.info(`Creating container for image: ${options.imageName}`);

    return await dockerode.createContainer({
      name: options.name,
      User: options.user,
      Image: options.imageName.toString(),
      Env: getEnv(options.env),
      ExposedPorts: getExposedPorts(options.exposedPorts),
      Cmd: options.cmd,
      Labels: createLabels(options.imageName),
      // @ts-ignore
      Healthcheck: getHealthCheck(options.healthCheck),
      HostConfig: {
        IpcMode: options.ipcMode,
        ExtraHosts: getExtraHosts(options.extraHosts),
        AutoRemove: options.autoRemove,
        NetworkMode: options.networkMode,
        PortBindings: getPortBindings(options.exposedPorts),
        Binds: getBindMounts(options.bindMounts),
        Tmpfs: options.tmpFs,
        LogConfig: getLogConfig(options.useDefaultLogDriver),
        Privileged: options.privilegedMode,
      },
    });
  } catch (err) {
    log.error(`Failed to create container for image ${options.imageName}: ${err}`);
    throw err;
  }
};

type DockerodeEnvironment = string[];

const getEnv = (env: Env): DockerodeEnvironment =>
  Object.entries(env).reduce(
    (dockerodeEnvironment, [key, value]) => [...dockerodeEnvironment, `${key}=${value}`],
    [] as DockerodeEnvironment
  );

type DockerodeExposedPorts = { [port in PortString]: Record<string, unknown> };

const getExposedPorts = (exposedPorts: Port[]): DockerodeExposedPorts => {
  const dockerodeExposedPorts: DockerodeExposedPorts = {};
  for (const exposedPort of exposedPorts) {
    dockerodeExposedPorts[exposedPort.toString()] = {};
  }
  return dockerodeExposedPorts;
};

const getExtraHosts = (extraHosts: ExtraHost[]): string[] => {
  return extraHosts.map((extraHost) => `${extraHost.host}:${extraHost.ipAddress}`);
};

const getPortBindings = (exposedPorts: Port[]): DockerodePortBindings => {
  const dockerodePortBindings: DockerodePortBindings = {};
  for (const exposedPort of exposedPorts) {
    dockerodePortBindings[exposedPort] = [{ HostPort: "0" }];
  }
  return dockerodePortBindings;
};

const getBindMounts = (bindMounts: BindMount[]): string[] => {
  return bindMounts.map(({ source, target, bindMode }) => `${source}:${target}:${bindMode}`);
};

type DockerodeHealthCheck = {
  Test: string[];
  Interval: number;
  Timeout: number;
  Retries: number;
  StartPeriod: number;
};

const getHealthCheck = (healthCheck?: HealthCheck): DockerodeHealthCheck | undefined => {
  if (healthCheck === undefined) {
    return undefined;
  }

  return {
    Test: ["CMD-SHELL", healthCheck.test],
    Interval: healthCheck.interval ? toNanos(healthCheck.interval) : 0,
    Timeout: healthCheck.timeout ? toNanos(healthCheck.timeout) : 0,
    Retries: healthCheck.retries || 0,
    StartPeriod: healthCheck.startPeriod ? toNanos(healthCheck.startPeriod) : 0,
  };
};

const toNanos = (duration: number): number => duration * 1e6;

type DockerodeLogConfig = {
  Type: string;
  Config: Record<string, unknown>;
};

const getLogConfig = (useDefaultLogDriver: boolean): DockerodeLogConfig | undefined => {
  if (!useDefaultLogDriver) {
    return undefined;
  }

  return {
    Type: "json-file",
    Config: {},
  };
};