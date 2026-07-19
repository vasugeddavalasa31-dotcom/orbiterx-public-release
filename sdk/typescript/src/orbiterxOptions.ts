export type OrbiterXConfigValue = string | number | boolean | OrbiterXConfigValue[] | OrbiterXConfigObject;

export type OrbiterXConfigObject = { [key: string]: OrbiterXConfigValue };

export type OrbiterXOptions = {
  orbiterxPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * Additional `--config key=value` overrides to pass to the OrbiterX CLI.
   *
   * Provide a JSON object and the SDK will flatten it into dotted paths and
   * serialize values as TOML literals so they are compatible with the CLI's
   * `--config` parsing.
   */
  config?: OrbiterXConfigObject;
  /**
   * Environment variables passed to the OrbiterX CLI process. When provided, the SDK
   * will not inherit variables from `process.env`.
   */
  env?: Record<string, string>;
};
