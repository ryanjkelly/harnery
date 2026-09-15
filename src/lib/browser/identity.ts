/** Keep Chromium's UA, navigator.platform and client hints in one profile. */
export function browserIdentity(userAgent: string, browserVersion?: string) {
  const chrome = /(?:Chrome|Chromium)\/(\d+)\.([\d.]+)/.exec(userAgent);
  const windows = userAgent.includes("Windows NT");
  const mac = userAgent.includes("Macintosh");
  // A custom non-Chromium or non-desktop UA is an explicit caller choice.
  if (!chrome || (!windows && !mac)) return undefined;
  const major = chrome[1]!;
  const fullVersion = browserVersion?.startsWith(`${major}.`)
    ? browserVersion
    : `${major}.${chrome[2]}`;
  const brand = userAgent.includes("Edg/") ? "Microsoft Edge" : "Google Chrome";
  return {
    userAgent,
    platform: windows ? "Win32" : "MacIntel",
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand, version: major },
      ],
      fullVersionList: [
        { brand: "Chromium", version: fullVersion },
        { brand, version: fullVersion },
      ],
      platform: windows ? "Windows" : "macOS",
      platformVersion: windows ? "10.0.0" : "10.15.7",
      architecture: "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
}

/** Initial popup documents exist before Playwright can attach a page session. */
export function installDocumentIdentity(identity: NonNullable<ReturnType<typeof browserIdentity>>) {
  const metadata = identity.userAgentMetadata;
  const basics = { brands: metadata.brands, mobile: metadata.mobile, platform: metadata.platform };
  Object.defineProperty(Navigator.prototype, "platform", {
    configurable: true,
    get: () => identity.platform,
  });
  if (!("userAgentData" in navigator)) return;
  const nativeData = (navigator as Navigator & { userAgentData: object }).userAgentData;
  const data = Object.create(Object.getPrototypeOf(nativeData));
  for (const [name, value] of Object.entries(basics)) {
    Object.defineProperty(data, name, { enumerable: true, get: () => value });
  }
  Object.defineProperty(data, "toJSON", { value: () => ({ ...basics }) });
  Object.defineProperty(data, "getHighEntropyValues", {
    value: async (hints: string[]) => {
      const result: Record<string, unknown> = { ...basics };
      for (const hint of hints) {
        if (Object.hasOwn(metadata, hint)) result[hint] = metadata[hint as keyof typeof metadata];
      }
      return result;
    },
  });
  Object.defineProperty(Navigator.prototype, "userAgentData", {
    configurable: true,
    get: () => data,
  });
}
