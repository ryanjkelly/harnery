export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { startThumbnailBackground } = await import("./lib/thumbnail-background");
    startThumbnailBackground();
  }
}
