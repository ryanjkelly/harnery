export interface PaletteEntry {
  id: string;
  label: string;
  sublabel?: string;
  state?: string;
  href: string;
}

export interface PaletteCatalog {
  agents: PaletteEntry[];
  decisions: PaletteEntry[];
  workflows: PaletteEntry[];
}
