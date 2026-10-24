/**
 * bun test preload: keep browse runs in tests away from the machine's own
 * browser state. Under WSL a headless browse copies cookies from the Windows
 * sign-in profile before it loads a page; tests must never read that profile.
 */
process.env.HARNERY_BROWSER_LOGIN_SYNC = "off";
