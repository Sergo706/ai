/** The page was fetched without error but carried too little text to be usable. */
export class ContentTooShortError extends Error {
  readonly url: string;
  readonly characters: number;
  readonly minimum: number;

  constructor(url: string, characters: number, minimum: number) {
    super(
      `Extracted content for ${url} is too short to use: ${characters.toString()} characters (minimum ${minimum.toString()}).`,
    );
    this.name = "ContentTooShortError";
    this.url = url;
    this.characters = characters;
    this.minimum = minimum;
  }
}

export class NotExtractableError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`${url} is not HTML and cannot be extracted here (${reason}).`);
    this.name = "NotExtractableError";
    this.url = url;
    this.reason = reason;
  }
}

export class ExtractionDeadlineError extends Error {
  readonly url: string;
  readonly deadlineMs: number;

  constructor(url: string, deadlineMs: number) {
    super(
      `${url} exceeded the ${deadlineMs.toString()}ms extraction deadline.`,
    );
    this.name = "ExtractionDeadlineError";
    this.url = url;
    this.deadlineMs = deadlineMs;
  }
}
