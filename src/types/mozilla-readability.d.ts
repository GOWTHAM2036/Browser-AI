declare module '@mozilla/readability' {
  export interface ParseResult {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
  }

  export class Readability {
    constructor(doc: Document, options?: any);
    parse(): ParseResult | null;
  }
}
