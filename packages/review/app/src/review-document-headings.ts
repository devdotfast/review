export type ReviewTocLevel = "h2" | "h3";

export interface ReviewTocEntry {
  id: string;
  text: string;
  level: ReviewTocLevel;
}
