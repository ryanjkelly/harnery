export interface PaletteEntry {
  id: string;
  label: string;
  sublabel?: string;
  state?: string;
  href: string;
}

export interface PaletteCatalog {
  agents: PaletteEntry[];
  councils: PaletteEntry[];
  decisions: PaletteEntry[];
  work: PaletteEntry[];
  workflows: PaletteEntry[];
  goals: PaletteEntry[];
}
