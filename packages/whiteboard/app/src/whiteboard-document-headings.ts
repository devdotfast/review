export type WhiteboardTocLevel = "h2" | "h3";

export interface WhiteboardTocEntry {
  id: string;
  text: string;
  level: WhiteboardTocLevel;
}
