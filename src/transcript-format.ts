// Transcript paragraph formatter.
//
// This is a faithful TypeScript port of the Carbon Voice Flutter app's
// `ParagraphFormatterService`
// (lib/messages/presentation/widgets/formatter_message_transcription/). Raw
// transcripts come back from the API as one long run-on block; the app reflows
// them into readable paragraphs before showing them. We do the same here so
// transcripts synced into Obsidian read like prose — sentences grouped into
// paragraphs separated by a blank line (Markdown's paragraph break) instead of
// a single wall of text.
//
// Keep the language tables and heuristics in sync with the Flutter source so
// Obsidian notes match what users see in the app.

interface LanguageConfig {
  // Matches one sentence including its trailing punctuation. Must be global.
  punctuationRegex: RegExp
  sentencesPerParagraph: number
  lengthDifferenceThreshold: number
  joinWithSpace: boolean
  rightToLeft: boolean
}

// Default configuration for unsupported languages (mirrors the app's English-ish fallback).
const DEFAULT_CONFIG: LanguageConfig = {
  punctuationRegex: /[^.!?]+[.!?]+/g,
  sentencesPerParagraph: 3,
  lengthDifferenceThreshold: 50,
  joinWithSpace: true,
  rightToLeft: false,
}

// Language-specific formatting configurations.
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  english: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  chinese: {
    punctuationRegex: /[^。！？]+[。！？]+/g,
    sentencesPerParagraph: 2,
    lengthDifferenceThreshold: 30,
    joinWithSpace: false,
    rightToLeft: false,
  },
  japanese: {
    punctuationRegex: /[^。！？]+[。！？]+/g,
    sentencesPerParagraph: 2,
    lengthDifferenceThreshold: 30,
    joinWithSpace: false,
    rightToLeft: false,
  },
  korean: {
    punctuationRegex: /[^.!?。！？]+[.!?。！？]+/g,
    sentencesPerParagraph: 2,
    lengthDifferenceThreshold: 30,
    joinWithSpace: true,
    rightToLeft: false,
  },
  arabic: {
    punctuationRegex: /[^.!?؟،]+[.!?؟،]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: true,
  },
  hebrew: {
    punctuationRegex: /[^.!?׃]+[.!?׃]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: true,
  },
  hindi: {
    punctuationRegex: /[^.!?।॥]+[.!?।॥]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  thai: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 2,
    lengthDifferenceThreshold: 40,
    joinWithSpace: false,
    rightToLeft: false,
  },
  russian: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  vietnamese: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 2,
    lengthDifferenceThreshold: 40,
    joinWithSpace: true,
    rightToLeft: false,
  },
  french: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  german: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  persian: {
    punctuationRegex: /[^.!?؟،]+[.!?؟،]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: true,
  },
  danish: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  dutch: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  icelandic: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  indonesian: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 2,
    lengthDifferenceThreshold: 40,
    joinWithSpace: true,
    rightToLeft: false,
  },
  italian: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  norwegian: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  polish: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  portuguese: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  romanian: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  spanish: {
    punctuationRegex: /[^.!?¡¿…]+[.!?¡¿…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  swedish: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  turkish: {
    punctuationRegex: /[^.!?…]+[.!?…]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
  welsh: {
    punctuationRegex: /[^.!?]+[.!?]+/g,
    sentencesPerParagraph: 3,
    lengthDifferenceThreshold: 50,
    joinWithSpace: true,
    rightToLeft: false,
  },
}

// Transition words that start a new paragraph, keyed by language.
const TRANSITION_WORDS: Record<string, string[]> = {
  english: [
    'However', 'Therefore', 'Furthermore', 'Moreover', 'In addition', 'On the other hand',
    'Consequently', 'As a result', 'First', 'Second', 'Third', 'Finally', 'Meanwhile',
    'Subsequently', 'Thus', 'Nevertheless', 'Indeed', 'In conclusion', 'For example',
  ],
  arabic: [
    'ومع ذلك', 'لذلك', 'علاوة على ذلك', 'إضافة إلى ذلك', 'من ناحية أخرى', 'نتيجة لذلك',
    'أولا', 'ثانيا', 'ثالثا', 'أخيرا', 'في الواقع', 'على سبيل المثال', 'في الختام',
  ],
  chinese: [
    '然而', '因此', '此外', '而且', '另外', '另一方面', '结果', '首先', '其次', '第三',
    '最后', '同时', '例如', '总之', '总的来说', '换句话说',
  ],
  danish: [
    'Imidlertid', 'Derfor', 'Desuden', 'Endvidere', 'Derudover', 'På den anden side',
    'Følgelig', 'For det første', 'For det andet', 'For det tredje', 'Endelig', 'Samtidig',
  ],
  dutch: [
    'Echter', 'Daarom', 'Bovendien', 'Verder', 'Daarnaast', 'Anderzijds', 'Bijgevolg',
    'Ten eerste', 'Ten tweede', 'Ten derde', 'Tenslotte', 'Intussen',
  ],
  french: [
    'Cependant', 'Donc', 'En outre', 'De plus', "D'autre part", 'Par conséquent',
    'Premièrement', 'Deuxièmement', 'Troisièmement', 'Finalement', 'En effet',
  ],
  german: [
    'Jedoch', 'Deshalb', 'Außerdem', 'Darüber hinaus', 'Andererseits', 'Folglich',
    'Erstens', 'Zweitens', 'Drittens', 'Schließlich', 'Inzwischen',
  ],
  hebrew: [
    'אולם', 'לכן', 'יתר על כן', 'בנוסף', 'מצד שני', 'כתוצאה מכך', 'ראשית', 'שנית',
    'שלישית', 'לבסוף', 'בינתיים',
  ],
  hindi: [
    'हालांकि', 'इसलिए', 'इसके अलावा', 'इसके अतिरिक्त', 'दूसरी ओर', 'परिणामस्वरूप',
    'पहला', 'दूसरा', 'तीसरा', 'अंत में', 'वास्तव में',
  ],
  icelandic: [
    'Hins vegar', 'Því', 'Ennfremur', 'Að auki', 'Á hinn bóginn', 'Þar af leiðandi',
    'Í fyrsta lagi', 'Í öðru lagi', 'Í þriðja lagi', 'Loks', 'Á meðan',
  ],
  indonesian: [
    'Namun', 'Oleh karena itu', 'Selanjutnya', 'Selain itu', 'Di sisi lain', 'Akibatnya',
    'Pertama', 'Kedua', 'Ketiga', 'Akhirnya', 'Sementara itu',
  ],
  italian: [
    'Tuttavia', 'Pertanto', 'Inoltre', 'In aggiunta', "D'altra parte", 'Di conseguenza',
    'In primo luogo', 'In secondo luogo', 'In terzo luogo', 'Infine', 'Nel frattempo',
  ],
  japanese: [
    'しかし', 'したがって', 'さらに', 'その上', '一方', 'その結果', '第一に', '第二に',
    '第三に', '最後に', 'その間',
  ],
  korean: [
    '하지만', '따라서', '게다가', '또한', '반면에', '결과적으로', '첫째', '둘째', '셋째',
    '마지막으로', '한편',
  ],
  norwegian: [
    'Imidlertid', 'Derfor', 'Videre', 'I tillegg', 'På den annen side', 'Følgelig',
    'For det første', 'For det andre', 'For det tredje', 'Til slutt', 'I mellomtiden',
  ],
  polish: [
    'Jednak', 'Dlatego', 'Ponadto', 'Dodatkowo', 'Z drugiej strony', 'W konsekwencji',
    'Po pierwsze', 'Po drugie', 'Po trzecie', 'Wreszcie', 'Tymczasem',
  ],
  portuguese: [
    'Contudo', 'Portanto', 'Além disso', 'Ademais', 'Por outro lado', 'Consequentemente',
    'Primeiro', 'Segundo', 'Terceiro', 'Finalmente', 'Enquanto isso',
  ],
  romanian: [
    'Totuși', 'Prin urmare', 'În plus', 'Mai mult', 'Pe de altă parte', 'În consecință',
    'În primul rând', 'În al doilea rând', 'În al treilea rând', 'În sfârșit', 'Între timp',
  ],
  russian: [
    'Однако', 'Поэтому', 'Кроме того', 'Более того', 'С другой стороны', 'Следовательно',
    'Во-первых', 'Во-вторых', 'В-третьих', 'Наконец', 'Тем временем',
  ],
  spanish: [
    'Sin embargo', 'Por lo tanto', 'Además', 'Asimismo', 'Por otro lado', 'En consecuencia',
    'Primero', 'Segundo', 'Tercero', 'Finalmente', 'Mientras tanto',
  ],
  swedish: [
    'Emellertid', 'Därför', 'Dessutom', 'Vidare', 'Å andra sidan', 'Följaktligen',
    'För det första', 'För det andra', 'För det tredje', 'Slutligen', 'Under tiden',
  ],
  turkish: [
    'Ancak', 'Bu nedenle', 'Ayrıca', 'Dahası', 'Öte yandan', 'Sonuç olarak', 'Birincisi',
    'İkincisi', 'Üçüncüsü', 'Son olarak', 'Bu arada',
  ],
  vietnamese: [
    'Tuy nhiên', 'Do đó', 'Hơn nữa', 'Ngoài ra', 'Mặt khác', 'Kết quả là', 'Thứ nhất',
    'Thứ hai', 'Thứ ba', 'Cuối cùng', 'Trong khi đó',
  ],
  welsh: [
    'Fodd bynnag', 'Felly', 'Ymhellach', 'Yn ogystal', 'Ar y llaw arall', 'O ganlyniad',
    'Yn gyntaf', 'Yn ail', 'Yn drydydd', 'Yn olaf', 'Yn y cyfamser',
  ],
  persian: [
    'با این حال', 'بنابراین', 'علاوه بر این', 'همچنین', 'به علاوه', 'از طرف دیگر',
    'در نتیجه', 'در نهایت', 'اول', 'دوم', 'سوم', 'سرانجام', 'در این میان', 'متعاقباً',
    'بدین ترتیب', 'با این وجود', 'در واقع', 'در پایان', 'برای مثال',
  ],
  thai: [
    'อย่างไรก็ตาม', 'ดังนั้น', 'นอกจากนี้', 'ยิ่งไปกว่านั้น', 'เพิ่มเติม', 'ในทางกลับกัน',
    'ด้วยเหตุนี้', 'ส่งผลให้', 'ประการแรก', 'ประการที่สอง', 'ประการที่สาม', 'ในที่สุด',
    'ในระหว่างนี้', 'ต่อมา', 'ดังนี้', 'กระนั้น', 'ที่จริงแล้ว', 'สรุป', 'ตัวอย่างเช่น',
  ],
}

// Maps ISO 639-1 codes (and a couple of legacy aliases) to the language keys above, so a
// transcript's `language_id` — whether it's a full name like "english" or a code like
// "en"/"en-US" — resolves to the right config. Anything unknown falls back to English.
const ISO_TO_LANGUAGE: Record<string, string> = {
  en: 'english', ar: 'arabic', zh: 'chinese', da: 'danish', nl: 'dutch', fr: 'french',
  de: 'german', he: 'hebrew', iw: 'hebrew', hi: 'hindi', is: 'icelandic', id: 'indonesian',
  it: 'italian', ja: 'japanese', ko: 'korean', no: 'norwegian', nb: 'norwegian',
  nn: 'norwegian', pl: 'polish', pt: 'portuguese', ro: 'romanian', ru: 'russian',
  es: 'spanish', sv: 'swedish', tr: 'turkish', vi: 'vietnamese', cy: 'welsh', fa: 'persian',
  th: 'thai',
}

// Normalize an arbitrary language identifier to one of our config keys.
function normalizeLanguage(languageCode: string | null | undefined): string {
  if (!languageCode) return 'english'
  const lower = languageCode.trim().toLowerCase()
  if (lower in LANGUAGE_CONFIGS) return lower
  // Strip any region/script suffix ("en-US", "zh_Hans") and map the base ISO code.
  const base = lower.split(/[-_]/)[0]
  return ISO_TO_LANGUAGE[base] ?? 'english'
}

// Detects whether the text already carries Markdown structure (headings, lists, bold, links,
// code). Mirrors the app's `_looksLikeMarkdown` — such text is left untouched so paragraph
// reflowing never mangles a list or heading.
const MARKDOWN_PATTERN =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}\s|^\s*[-*+]\s+\S|^\s*\d+\.\s+\S|`[^`\n]+`|```|\[[^\]]+\]\([^)\s]+\))/m

function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_PATTERN.test(text)
}

// Replace only the first literal occurrence of `search` in `input`, treating both search and
// replacement as plain strings (no regex / `$` interpretation).
function replaceFirstLiteral(input: string, search: string, replacement: string): string {
  const idx = input.indexOf(search)
  if (idx === -1) return input
  return input.slice(0, idx) + replacement + input.slice(idx + search.length)
}

/**
 * Format a raw transcript into readable paragraphs.
 *
 * Sentences are grouped into paragraphs (by count, transition words, or a large length jump)
 * and joined with blank lines — the Markdown paragraph break — so the transcript reads like
 * prose in Obsidian instead of one run-on block. Returns the input unchanged when it's empty,
 * already looks like Markdown, or anything goes wrong.
 *
 * @param text The raw transcript text.
 * @param languageCode The transcript language (full name like "english" or an ISO code like
 *   "en"/"en-US"); defaults to English.
 */
export function formatTranscript(text: string, languageCode?: string | null): string {
  if (!text) return ''

  // Don't reflow text that already carries Markdown structure — it would break lists/headings.
  if (looksLikeMarkdown(text)) return text

  const language = normalizeLanguage(languageCode)

  try {
    const config = LANGUAGE_CONFIGS[language] ?? DEFAULT_CONFIG
    const transitionWords = TRANSITION_WORDS[language] ?? TRANSITION_WORDS.english

    // Protect URLs, bare domains, and decimal numbers from being split at the ".".
    const urlPattern = /https?:\/\/[^\s]+/g
    const domainPattern = /\b[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\b/g
    const decimalPattern = /\b\d+\.\d+\b/g

    const urls: Record<string, string> = {}
    const domains: Record<string, string> = {}
    const decimals: Record<string, string> = {}
    let processedText = text

    // URLs first (more specific than bare domains), matched against the original text.
    let urlIndex = 0
    for (const match of text.matchAll(urlPattern)) {
      const url = match[0]
      const placeholder = `__URL_${urlIndex}__`
      urls[placeholder] = url
      processedText = replaceFirstLiteral(processedText, url, placeholder)
      urlIndex++
    }

    // Bare domains (those inside URLs are already placeholders and won't match).
    let domainIndex = 0
    for (const match of processedText.matchAll(domainPattern)) {
      const domain = match[0]
      const placeholder = `__DOMAIN_${domainIndex}__`
      domains[placeholder] = domain
      processedText = replaceFirstLiteral(processedText, domain, placeholder)
      domainIndex++
    }

    // Decimal numbers.
    let decimalIndex = 0
    for (const match of processedText.matchAll(decimalPattern)) {
      const decimal = match[0]
      const placeholder = `__DECIMAL_${decimalIndex}__`
      decimals[placeholder] = decimal
      processedText = replaceFirstLiteral(processedText, decimal, placeholder)
      decimalIndex++
    }

    // Regex that fires when a sentence starts (or, for RTL, ends) with a transition word.
    const transitionWordsPattern = new RegExp(
      config.rightToLeft ? `(${transitionWords.join('|')})\\s*$` : `^(${transitionWords.join('|')})`,
      'i'
    )

    // Honour paragraph breaks the transcript already carries (some transcripts — e.g. AI
    // briefings — arrive pre-formatted) and group each block independently, so we never flatten
    // an existing break.
    const blocks = processedText.split(/\n[ \t]*\n+/).filter(b => b.trim().length > 0)

    const paragraphs: string[] = []
    for (const block of blocks) {
      // Split the block into sentences on language-specific punctuation. `matchAll` only yields
      // text up to a closing `.!?…`, so capture whatever trails the last one separately —
      // voice transcripts frequently don't end with punctuation, and dropping that remainder
      // would silently lose the final utterance. (The app avoids this for audio via its
      // time-code paragraph builder; we only have the transcript string, so we handle it here.)
      const matches = [...block.matchAll(config.punctuationRegex)]
      const sentences = matches.map(m => m[0])
      const last = matches[matches.length - 1]
      const consumedEnd = last ? (last.index ?? 0) + last[0].length : 0
      const remainder = block.slice(consumedEnd).trim()
      if (remainder) sentences.push(remainder)
      if (sentences.length === 0) sentences.push(block)

      // Group sentences into paragraphs.
      let currentParagraph: string[] = []
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim()

        const shouldStartNewParagraph =
          transitionWordsPattern.test(sentence) ||
          currentParagraph.length >= config.sentencesPerParagraph ||
          (i > 0 &&
            currentParagraph.length > 0 &&
            Math.abs(sentence.length - currentParagraph[currentParagraph.length - 1].length) >
              config.lengthDifferenceThreshold)

        if (shouldStartNewParagraph && currentParagraph.length > 0) {
          paragraphs.push(currentParagraph.join(config.joinWithSpace ? ' ' : ''))
          currentParagraph = []
        }

        currentParagraph.push(sentence)
      }

      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(config.joinWithSpace ? ' ' : ''))
      }
    }

    // Bidi markers for RTL languages (match the app's plain-text output):
    // ‫ RIGHT-TO-LEFT EMBEDDING … ‬ POP DIRECTIONAL FORMATTING.
    const rtlMarker = config.rightToLeft ? '‫' : ''
    const ltrMarker = config.rightToLeft ? '‬' : ''

    // Restore the protected URLs / domains / decimals.
    const restored = paragraphs.map(p => {
      let out = p
      for (const [placeholder, url] of Object.entries(urls)) out = out.split(placeholder).join(url)
      for (const [placeholder, domain] of Object.entries(domains)) out = out.split(placeholder).join(domain)
      for (const [placeholder, decimal] of Object.entries(decimals)) out = out.split(placeholder).join(decimal)
      return `${rtlMarker}${out}${ltrMarker}`
    })

    return restored.join('\n\n')
  } catch {
    // Never let a formatting hiccup drop the transcript — fall back to the raw text.
    return text
  }
}
