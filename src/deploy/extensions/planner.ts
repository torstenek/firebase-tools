import * as semver from "semver";

import * as extensionsApi from "../../extensions/extensionsApi";
import * as refs from "../../extensions/refs";
import { FirebaseError } from "../../error";
import { getFirebaseProjectParams, substituteParams } from "../../extensions/extensionsHelper";
import { logger } from "../../logger";
import { readInstanceParam } from "../../extensions/manifest";
import { ParamBindingOptions } from "../../extensions/paramHelper";

/**
 * Instance spec used by manifest.
 *
 * Params are passed in ParamBindingOptions so we know the param bindings for
 * all environments user has configured.
 *
 * So far this is only used for writing to the manifest, but in the future
 * we want to read manifest into this interface.
 */
export interface ManifestInstanceSpec {
  instanceId: string;
  params: Record<string, ParamBindingOptions>;
  ref?: refs.Ref;
  paramSpecs?: extensionsApi.Param[];
}

// TODO(lihes): Rename this to something like DeploymentInstanceSpec.
/**
 * Instance spec used for deploying extensions to firebase project or emulator.
 *
 * Param bindings are expected to be collapsed from ParamBindingOptions into a Record<string, string>.
 */
export interface InstanceSpec {
  instanceId: string;
  ref?: refs.Ref;
  params: Record<string, string>;
  extensionVersion?: extensionsApi.ExtensionVersion;
  extension?: extensionsApi.Extension;
}

/**
 * Caching fetcher for the corresponding ExtensionVersion for an instance spec.
 */
export async function getExtensionVersion(
  i: InstanceSpec
): Promise<extensionsApi.ExtensionVersion> {
  if (!i.extensionVersion) {
    if (!i.ref) {
      throw new FirebaseError(
        `Can't get ExtensionVersion for ${i.instanceId} because it has no ref`
      );
    }
    i.extensionVersion = await extensionsApi.getExtensionVersion(refs.toExtensionVersionRef(i.ref));
  }
  return i.extensionVersion;
}

/**
 * Caching fetcher for the corresponding Extension for an instance spec.
 */
export async function getExtension(i: InstanceSpec): Promise<extensionsApi.Extension> {
  if (!i.ref) {
    throw new FirebaseError(`Can't get Extensionfor ${i.instanceId} because it has no ref`);
  }
  if (!i.extension) {
    i.extension = await extensionsApi.getExtension(refs.toExtensionRef(i.ref));
  }
  return i.extension;
}

/**
 * have checks a project for what extension instances are currently installed,
 * and returns them as a list of instanceSpecs.
 * @param projectId
 */
export async function have(projectId: string): Promise<InstanceSpec[]> {
  const instances = await extensionsApi.listInstances(projectId);
  return instances.map((i) => {
    const dep: InstanceSpec = {
      instanceId: i.name.split("/").pop()!,
      params: i.config.params,
    };
    if (i.config.extensionRef) {
      const ref = refs.parse(i.config.extensionRef);
      dep.ref = ref;
      dep.ref.version = i.config.extensionVersion;
    }
    return dep;
  });
}

/**
 * want checks firebase.json and the extensions directory for which extensions
 * the user wants installed on their project.
 * @param projectId The project we are deploying to
 * @param projectNumber The project number we are deploying to. Used for checking .env files.
 * @param aliases An array of aliases for the project we are deploying to. Used for checking .env files.
 * @param projectDir The directory containing firebase.json and extensions/
 * @param extensions The extensions section of firebase.jsonm
 * @param emulatorMode Whether the output will be used by the Extensions emulator.
 *                     If true, this will check {instanceId}.env.local for params and will respect `demo-` project rules.
 */
export async function want(args: {
  projectId: string;
  projectNumber: string;
  aliases: string[];
  projectDir: string;
  extensions: Record<string, string>;
  emulatorMode?: boolean;
}): Promise<InstanceSpec[]> {
  const instanceSpecs: InstanceSpec[] = [];
  const errors: FirebaseError[] = [];
  for (const e of Object.entries(args.extensions)) {
    try {
      const instanceId = e[0];
      const ref = refs.parse(e[1]);
      ref.version = await resolveVersion(ref);

      const params = readInstanceParam({
        projectDir: args.projectDir,
        instanceId,
        projectId: args.projectId,
        projectNumber: args.projectNumber,
        aliases: args.aliases,
        checkLocal: args.emulatorMode,
      });
      const autoPopulatedParams = await getFirebaseProjectParams(args.projectId, args.emulatorMode);
      const subbedParams = substituteParams(params, autoPopulatedParams);

      instanceSpecs.push({
        instanceId,
        ref,
        params: subbedParams,
      });
    } catch (err: any) {
      logger.debug(`Got error reading extensions entry ${e}: ${err}`);
      errors.push(err as FirebaseError);
    }
  }
  if (errors.length) {
    const messages = errors.map((err) => `- ${err.message}`).join("\n");
    throw new FirebaseError(`Errors while reading 'extensions' in 'firebase.json'\n${messages}`);
  }
  return instanceSpecs;
}

/**
 * resolveVersion resolves a semver string to the max matching version.
 * Exported for testing.
 * @param publisherId
 * @param extensionId
 * @param version a semver or semver range
 */
export async function resolveVersion(ref: refs.Ref): Promise<string> {
  const extensionRef = refs.toExtensionRef(ref);
  const versions = await extensionsApi.listExtensionVersions(extensionRef);
  if (versions.length === 0) {
    throw new FirebaseError(`No versions found for ${extensionRef}`);
  }
  if (!ref.version || ref.version === "latest") {
    return versions
      .map((ev) => ev.spec.version)
      .sort(semver.compare)
      .pop()!;
  }
  const maxSatisfying = semver.maxSatisfying(
    versions.map((ev) => ev.spec.version),
    ref.version
  );
  if (!maxSatisfying) {
    throw new FirebaseError(
      `No version of ${extensionRef} matches requested version ${ref.version}`
    );
  }
  return maxSatisfying;
}
