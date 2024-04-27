import { AuthConfig, BuildArgs, RegistryConfig } from "../types";
import path from "path";
import { GenericContainer } from "./generic-container";
import { ImagePullPolicy, PullPolicy } from "../utils/pull-policy";
import { log, RandomUuid, Uuid } from "../common";
import { getAuthConfig, getContainerRuntimeClient, ImageName, type ContainerRuntimeClient } from "../container-runtime";
import { getReaper } from "../reaper/reaper";
import { getDockerfileImages } from "../utils/dockerfile-parser";
import { createLabels, LABEL_TESTCONTAINERS_SESSION_ID } from "../utils/labels";
import { Wait } from "../wait-strategies/wait";
import tar from "tar-stream";
import { pipeline } from "stream/promises";

export type BuildOptions = {
  deleteOnExit: boolean;
};

export class GenericContainerBuilder {
  private buildArgs: BuildArgs = {};
  private pullPolicy: ImagePullPolicy = PullPolicy.defaultPolicy();
  private cache = true;
  private target?: string;
  private useBuildKit = false;

  constructor(
    private readonly context: string,
    private readonly dockerfileName: string,
    private readonly uuid: Uuid = new RandomUuid()
  ) {}

  public withBuildArgs(buildArgs: BuildArgs): GenericContainerBuilder {
    this.buildArgs = buildArgs;
    return this;
  }

  public withPullPolicy(pullPolicy: ImagePullPolicy): this {
    this.pullPolicy = pullPolicy;
    return this;
  }

  public withCache(cache: boolean): this {
    this.cache = cache;
    return this;
  }

  public withTarget(target: string): this {
    this.target = target;
    return this;
  }

  public withBuildKit(useBuildKit = true): this {
    this.useBuildKit = useBuildKit;
    return this;
  }

  public async build(
    image = `localhost/${this.uuid.nextUuid()}:${this.uuid.nextUuid()}`,
    options: BuildOptions = { deleteOnExit: true }
  ): Promise<GenericContainer> {
    const client = await getContainerRuntimeClient();
    const reaper = await getReaper(client);

    const imageName = ImageName.fromString(image);
    const dockerfile = path.resolve(this.context, this.dockerfileName);

    const imageNames = await getDockerfileImages(dockerfile, this.buildArgs);
    const registryConfig = await this.getRegistryConfig(client.info.containerRuntime.indexServerAddress, imageNames);
    const labels = createLabels();
    if (options.deleteOnExit) {
      labels[LABEL_TESTCONTAINERS_SESSION_ID] = reaper.sessionId;
    }

    log.info(`Building Dockerfile "${dockerfile}" as image "${imageName.string}"...`);

    if (this.useBuildKit) {
      await this.buildWithBuildKit(client, imageName.string, registryConfig, labels);
    } else {
      await client.image.build(this.context, {
        t: imageName.string,
        dockerfile: this.dockerfileName,
        buildargs: this.buildArgs,
        pull: this.pullPolicy.shouldPull() ? "true" : undefined,
        nocache: !this.cache,
        registryconfig: registryConfig,
        labels,
        target: this.target,
      });
    }

    const container = new GenericContainer(imageName.string);
    if (!(await client.image.exists(imageName))) {
      throw new Error("Failed to build image");
    }
    return Promise.resolve(container);
  }

  private async buildWithBuildKit(
    client: ContainerRuntimeClient,
    image: string,
    registryConfig: RegistryConfig,
    labels: Record<string, string>
  ) {
    const command = [
      "build",
      "--frontend",
      "dockerfile.v0",
      "--local",
      "context=/work",
      "--local",
      "dockerfile=/work",
      "--opt",
      `filename=./${this.dockerfileName}`,
      "--output",
      `type=docker,name=${image},dest=/tmp/image.tar`,
    ];

    for (const [key, value] of Object.entries(this.buildArgs)) {
      command.push("--opt", `build-arg:${key}=${value}`);
    }

    if (this.pullPolicy.shouldPull()) {
      command.push("--opt", "image-resolve-mode=pull");
    }

    if (!this.cache) {
      command.push("--opt", "no-cache=true");
    }

    for (const [registry, auth] of Object.entries(registryConfig)) {
      command.push("--opt", `registry.auth=${registry}=${auth.username}:${auth.password}`);
    }

    for (const [key, value] of Object.entries(labels)) {
      command.push("--opt", `label:${key}=${value}`);
    }

    if (this.target) {
      command.push("--opt", `target=${this.target}`);
    }

    const buildKit = await new GenericContainer("moby/buildkit:v0.13.2")
      .withPrivilegedMode()
      .withBindMounts([
        { source: this.context, target: "/work" },
        { source: "/tmp/testcontainers_buildcache", target: "/var/lib/buildkit" },
      ])
      .withEntrypoint(["buildctl-daemonless.sh"])
      .withCommand(command)
      .withWaitStrategy(Wait.forOneShotStartup())
      .start();

    const archiveStream = await buildKit.copyArchiveFromContainer("/tmp/image.tar");
    const extractStream = tar.extract();

    extractStream.on("entry", (_header, imageStream, next) => {
      client.image.load(imageStream).then(next).catch(next);
    });

    await pipeline(archiveStream, extractStream);
  }

  private async getRegistryConfig(indexServerAddress: string, imageNames: ImageName[]): Promise<RegistryConfig> {
    const authConfigs: AuthConfig[] = [];

    await Promise.all(
      imageNames.map(async (imageName) => {
        const authConfig = await getAuthConfig(imageName.registry ?? indexServerAddress);

        if (authConfig !== undefined) {
          authConfigs.push(authConfig);
        }
      })
    );

    return authConfigs
      .map((authConfig) => {
        return {
          [authConfig.registryAddress]: {
            username: authConfig.username,
            password: authConfig.password,
          },
        };
      })
      .reduce((prev, next) => ({ ...prev, ...next }), {} as RegistryConfig);
  }
}
