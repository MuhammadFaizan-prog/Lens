/**
 * About / third-party notices shown in the editor (About sheet). Licences that require attribution
 * (CC-BY-4.0 translation models) are credited here and in docs/Translation.md.
 */
export const ABOUT_NOTICES: Array<{ what: string; licence: string; credit: string }> = [
  { what: "Caption translation runtime", licence: "MIT", credit: "CTranslate2 (OpenNMT); SentencePiece (Google, Apache-2.0)" },
  { what: "English → French and English → Urdu translation models", licence: "CC-BY-4.0",
    credit: "OPUS-MT by Jörg Tiedemann and Santhosh Thottingal, “OPUS-MT — Building open translation services for the World”, EAMT 2020 (Helsinki-NLP), converted to CTranslate2 by the Argos Translate project. Lens runs them unmodified." },
  { what: "English → Spanish, German and Arabic translation models", licence: "MIT / CC0-1.0", credit: "Argos Translate (Argos Open Technologies), trained with OpenNMT on OPUS corpora" },
  { what: "Speech-to-text", licence: "MIT", credit: "faster-whisper (SYSTRAN) with OpenAI Whisper base.en weights" },
  { what: "Fonts", licence: "SIL OFL 1.1", credit: "Inter (Rasmus Andersson), JetBrains Mono (JetBrains), Noto Naskh Arabic (The Noto Project Authors), and, from github.com/google/fonts: Poppins, Montserrat, Roboto, Open Sans, Oswald and Caveat (their Project Authors), Bebas Neue (Dharma Type), DM Serif Display (Adobe, Google LLC)" },
];
