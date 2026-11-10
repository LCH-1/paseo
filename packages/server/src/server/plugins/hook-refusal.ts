/**
 * A before hook answered by throwing, which is how a plugin turns a request down (for example when
 * no account has quota left). A hook that timed out, crashed, or broke the hook contract is a fault
 * and stays a plain error.
 */
export class PluginHookRefusalError extends Error {
  constructor(
    readonly pluginId: string,
    readonly hook: string,
    readonly reason: string,
    options: ErrorOptions,
  ) {
    super(`Plugin ${pluginId} before ${hook} failed: ${reason}`, options);
  }
}
