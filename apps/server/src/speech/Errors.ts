import { Schema } from "effect";

export class SpeechToTextConfigError extends Schema.TaggedErrorClass<SpeechToTextConfigError>()(
  "SpeechToTextConfigError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unable to load speech-to-text config at ${this.configPath}: ${this.detail}`;
  }
}

export class SpeechToTextRuntimeError extends Schema.TaggedErrorClass<SpeechToTextRuntimeError>()(
  "SpeechToTextRuntimeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
