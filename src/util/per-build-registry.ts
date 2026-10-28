// The list of per-build registries: module-global state every build must install before it
// generates anything. Each registry declares itself here when its module loads, and its
// install function reports in each time it runs, so a test can check that a build installed
// every registry that exists rather than trusting `installBuildRegistries`' hand-kept list.

const declared = new Set<string>();
const installedThisBuild = new Set<string>();

/**
 * Declares a per-build registry. Call it at module scope, next to the state it guards.
 *
 * @param name - Names the registry in a test failure.
 * @returns Reports the registry installed for the current build; call it from the install.
 */
export const declarePerBuildRegistry = (name: string): (() => void) => {
  declared.add(name);
  return () => {
    installedThisBuild.add(name);
  };
};

/** Starts a build's install, forgetting which registries the previous build installed. */
export const beginPerBuildInstall = (): void => {
  installedThisBuild.clear();
};

/** The registries declared but not installed since the last {@link beginPerBuildInstall}. */
export const uninstalledPerBuildRegistries = (): string[] =>
  [...declared].filter((name) => !installedThisBuild.has(name));

/** Every registry declared so far. */
export const declaredPerBuildRegistries = (): string[] => [...declared];
