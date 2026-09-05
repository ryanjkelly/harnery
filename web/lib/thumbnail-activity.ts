type Activity = (folder: string) => void;
const shared = globalThis as typeof globalThis & {
  __harneryThumbnailActivity?: Map<string, Activity>;
};
shared.__harneryThumbnailActivity ??= new Map<string, Activity>();
export const thumbnailActivity = shared.__harneryThumbnailActivity;

export function noteThumbnailFolder(root: string, folder: string) {
  thumbnailActivity.get(root)?.(folder);
}
