/**
 * Codec is a fixed dark scene: its stylesheets set hundreds of colours for a
 * dark stage, so it stays dark whatever theme the rest of the dashboard uses.
 * Custom properties and `dark:` variants both reach through `display: contents`.
 */
export default function CodecLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark contents" style={{ colorScheme: "dark" }}>
      {children}
    </div>
  );
}
