export type RuntimeEnvironment = "development" | "test" | "production";

/**
 * Reads the application environment at request time. Production bundlers may
 * replace NODE_ENV while compiling, so APP_RUNTIME_ENV is the explicit runtime
 * control used by standalone deployments and local production-bundle tests.
 */
export function runtimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeEnvironment {
  const configured = env.APP_RUNTIME_ENV?.trim().toLocaleLowerCase("en-US");
  if (configured) {
    if (configured === "development" || configured === "test" || configured === "production") {
      return configured;
    }
    throw new Error("APP_RUNTIME_ENV must be `development`, `test`, or `production`.");
  }

  return env.NODE_ENV === "production"
    ? "production"
    : env.NODE_ENV === "test"
      ? "test"
      : "development";
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return runtimeEnvironment(env) === "production";
}
