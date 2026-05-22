/**
 * Language detection and translation utilities for Tilapiya CRM.
 * Handles multilingual WhatsApp messages (Sinhala, Tamil, English, etc.)
 * No external dependencies beyond built-in fetch (Node 18+).
 *
 * @module api/utils/language
 */

// ---------------------------------------------------------------------------
// Unicode-range helpers
// ---------------------------------------------------------------------------

const UNICODE_RANGES = {
  si: { start: 0x0d80, end: 0x0dff, name: 'Sinhala' },
  ta: { start: 0x0b80, end: 0x0bff, name: 'Tamil' },
  ar: { start: 0x0600, end: 0x06ff, name: 'Arabic' },
  zh: { start: 0x4e00, end: 0x9fff, name: 'Chinese' },       // CJK Unified
  ja: { start: 0x3040, end: 0x309f, name: 'Japanese' },       // Hiragana
  ko: { start: 0xac00, end: 0xd7af, name: 'Korean' },         // Hangul Syllables
};

// Extended ranges for more accurate CJK detection
const EXTRA_RANGES = {
  ja: [
    { start: 0x30a0, end: 0x30ff },  // Katakana
    { start: 0x31f0, end: 0x31ff },  // Katakana Phonetic Extensions
  ],
  zh: [
    { start: 0x3400, end: 0x4dbf },  // CJK Extension A
    { start: 0x2e80, end: 0x2eff },  // CJK Radicals Supplement
  ],
  ar: [
    { start: 0x0750, end: 0x077f },  // Arabic Supplement
    { start: 0xfb50, end: 0xfdff },  // Arabic Presentation Forms-A
  ],
};

// ---------------------------------------------------------------------------
// Language name map
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES = {
  si: 'Sinhala',
  ta: 'Tamil',
  en: 'English',
  ar: 'Arabic',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  bn: 'Bengali',
  te: 'Telugu',
  ml: 'Malayalam',
  kn: 'Kannada',
  gu: 'Gujarati',
  pa: 'Punjabi',
  ur: 'Urdu',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  pt: 'Portuguese',
  ru: 'Russian',
  th: 'Thai',
  vi: 'Vietnamese',
  ms: 'Malay',
};

// ---------------------------------------------------------------------------
// 1. detectLanguage
// ---------------------------------------------------------------------------

/**
 * Quick, rule-based language detection using Unicode character ranges.
 * No network calls or AI involved -- purely local.
 *
 * Checks the first 200 characters of the text. The language whose script
 * characters appear most frequently wins. Falls back to 'en'.
 *
 * @param {string} text - The input text to analyse.
 * @returns {string} ISO-style language code: 'si', 'ta', 'en', 'ar', 'zh', 'ja', 'ko'.
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en';

  const sample = text.slice(0, 200);
  const counts = {};

  for (const char of sample) {
    const code = char.codePointAt(0);

    for (const [lang, range] of Object.entries(UNICODE_RANGES)) {
      if (code >= range.start && code <= range.end) {
        counts[lang] = (counts[lang] || 0) + 1;
        break; // one char can only match one primary range
      }
    }

    // Check extended ranges
    for (const [lang, ranges] of Object.entries(EXTRA_RANGES)) {
      for (const range of ranges) {
        if (code >= range.start && code <= range.end) {
          counts[lang] = (counts[lang] || 0) + 1;
        }
      }
    }
  }

  // Pick the language with the highest count (minimum 1 match required)
  let best = 'en';
  let bestCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// 2. getLanguageName
// ---------------------------------------------------------------------------

/**
 * Convert a language code to its full English name.
 *
 * @param {string} code - Language code, e.g. 'si', 'ta', 'en'.
 * @returns {string} Full name, e.g. 'Sinhala'. Returns the code itself if unknown.
 */
function getLanguageName(code) {
  if (!code) return 'Unknown';
  return LANGUAGE_NAMES[code.toLowerCase()] || code;
}

// ---------------------------------------------------------------------------
// 3. detectAndTranslate
// ---------------------------------------------------------------------------

/**
 * AI-powered language detection and translation via OpenAI GPT-4o-mini.
 *
 * Sends the text to GPT-4o-mini to detect the language and, if the text is
 * not English, returns an English translation alongside the original.
 *
 * Falls back to the local `detectLanguage` function if the API call fails.
 *
 * @param {string} text        - The user's message text.
 * @param {string} openaiKey   - OpenAI API key.
 * @returns {Promise<{
 *   language_code: string,
 *   language_name: string,
 *   original_text: string,
 *   translated_text: string,
 *   is_english: boolean
 * }>}
 */
async function detectAndTranslate(text, openaiKey) {
  if (!text || typeof text !== 'string') {
    return {
      language_code: 'en',
      language_name: 'English',
      original_text: text || '',
      translated_text: text || '',
      is_english: true,
    };
  }

  // Fast path: if basic detection says English, skip the API call
  const quickDetect = detectLanguage(text);
  if (quickDetect === 'en') {
    // Heuristic: if every character is ASCII/Latin, treat as English
    const nonLatinCount = [...text].filter(
      (c) => c.codePointAt(0) > 0x024f && !/\s/.test(c) && !/\p{P}/u.test(c) && !/\d/.test(c)
    ).length;
    if (nonLatinCount === 0) {
      return {
        language_code: 'en',
        language_name: 'English',
        original_text: text,
        translated_text: text,
        is_english: true,
      };
    }
  }

  if (!openaiKey) {
    // No API key -- return basic detection without translation
    const code = quickDetect;
    return {
      language_code: code,
      language_name: getLanguageName(code),
      original_text: text,
      translated_text: text, // can't translate without key
      is_english: code === 'en',
    };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content: [
              'You are a language detection and translation assistant.',
              'Given user text, respond ONLY with valid JSON (no markdown) in this format:',
              '{"language_code":"xx","language_name":"LanguageName","translated_text":"English translation here","is_english":false}',
              'Use ISO 639-1 codes. For Sinhala use "si", for Tamil use "ta".',
              'If the text is already English, set translated_text to the original text and is_english to true.',
            ].join(' '),
          },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    // Strip markdown code fences if present
    const jsonStr = content.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(jsonStr);

    return {
      language_code: parsed.language_code || quickDetect,
      language_name: parsed.language_name || getLanguageName(parsed.language_code || quickDetect),
      original_text: text,
      translated_text: parsed.translated_text || text,
      is_english: Boolean(parsed.is_english),
    };
  } catch (err) {
    // Fallback to basic detection on any failure
    console.error('[language] detectAndTranslate failed, using fallback:', err.message);
    const code = quickDetect;
    return {
      language_code: code,
      language_name: getLanguageName(code),
      original_text: text,
      translated_text: text,
      is_english: code === 'en',
    };
  }
}

// ---------------------------------------------------------------------------
// 4. buildMultilingualSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Enhance a base system prompt with instructions to respond in the detected
 * language, plus cultural context for Sri Lankan languages.
 *
 * @param {string} basePrompt       - The existing system prompt.
 * @param {string} detectedLanguage - Language code from detectLanguage / detectAndTranslate.
 * @returns {string} Augmented system prompt.
 */
function buildMultilingualSystemPrompt(basePrompt, detectedLanguage) {
  if (!basePrompt) basePrompt = '';
  const lang = (detectedLanguage || 'en').toLowerCase();

  if (lang === 'en') {
    return basePrompt;
  }

  const langName = getLanguageName(lang);
  const lines = [
    basePrompt,
    '',
    `--- Language Instructions ---`,
    `The customer is writing in ${langName} (${lang}).`,
    `ALWAYS respond in ${langName}. Use natural, conversational ${langName}.`,
    `If you must include English terms (e.g. menu item names), keep the surrounding text in ${langName}.`,
  ];

  if (lang === 'si') {
    lines.push(
      '',
      '--- Sinhala Cultural Context ---',
      'Use informal/colloquial Sinhala (口语 style) unless the customer uses formal Sinhala.',
      'Sinhala has two registers: spoken (කතා බස) and written/formal (ලේඛන බස).',
      'For a WhatsApp conversation, prefer the spoken register unless the customer writes formally.',
      'Use common Sinhala greetings like "ආයුබෝවන්" (Ayubowan).',
      'Sri Lankan customers may mix Sinhala with English words -- this is natural, mirror their style.',
    );
  }

  if (lang === 'ta') {
    lines.push(
      '',
      '--- Tamil Cultural Context ---',
      'Use Sri Lankan Tamil conventions rather than Indian Tamil where they differ.',
      'Sri Lankan Tamil has its own colloquial expressions and loanwords from Sinhala/English.',
      'Use respectful forms of address. Tamil honorifics matter in customer service.',
      'Common greeting: "வணக்கம்" (Vanakkam).',
      'Customers may code-switch between Tamil and English -- match their style.',
    );
  }

  if (lang === 'ar') {
    lines.push(
      '',
      '--- Arabic Context ---',
      'Use Modern Standard Arabic unless the customer uses a specific dialect.',
      'Right-to-left text is handled by WhatsApp automatically.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 5. getCommonPhrases
// ---------------------------------------------------------------------------

/**
 * Get a set of common restaurant / CRM phrases translated into the
 * requested language. Useful for quick template responses.
 *
 * @param {string} language - Language code: 'si', 'ta', or 'en'.
 * @returns {{ greeting: string, thank_you: string, booking_confirmed: string,
 *             booking_cancelled: string, order_received: string, order_ready: string,
 *             anything_else: string, goodbye: string, welcome: string,
 *             sorry: string, please_wait: string }}
 */
function getCommonPhrases(language) {
  const phrases = {
    en: {
      greeting: 'Hello! Welcome to Tilapiya.',
      thank_you: 'Thank you!',
      booking_confirmed: 'Your booking has been confirmed.',
      booking_cancelled: 'Your booking has been cancelled.',
      order_received: 'We have received your order.',
      order_ready: 'Your order is ready!',
      anything_else: 'Is there anything else I can help you with?',
      goodbye: 'Thank you for choosing Tilapiya. See you soon!',
      welcome: 'Welcome!',
      sorry: 'We apologize for the inconvenience.',
      please_wait: 'Please wait a moment.',
    },
    si: {
      greeting: 'ආයුබෝවන්! Tilapiya වෙත සාදරයෙන් පිළිගනිමු.',
      thank_you: 'ස්තූතියි!',
      booking_confirmed: 'ඔබේ වෙන්කිරීම තහවුරු කර ඇත.',
      booking_cancelled: 'ඔබේ වෙන්කිරීම අවලංගු කර ඇත.',
      order_received: 'ඔබේ ඇණවුම අපට ලැබුණා.',
      order_ready: 'ඔබේ ඇණවුම සූදානම්!',
      anything_else: 'තවත් මොනවා හරි උදව් කරන්න තියෙනවද?',
      goodbye: 'Tilapiya තෝරා ගැනීමට ස්තූතියි. නැවත එන්න!',
      welcome: 'සාදරයෙන් පිළිගනිමු!',
      sorry: 'අපහසුතාවයට සමාවන්න.',
      please_wait: 'කරුණාකර මොහොතක් රැඳී සිටින්න.',
    },
    ta: {
      greeting: 'வணக்கம்! Tilapiya க்கு வரவேற்கிறோம்.',
      thank_you: 'நன்றி!',
      booking_confirmed: 'உங்கள் முன்பதிவு உறுதிசெய்யப்பட்டது.',
      booking_cancelled: 'உங்கள் முன்பதிவு ரத்துசெய்யப்பட்டது.',
      order_received: 'உங்கள் ஆர்டர் எங்களுக்கு கிடைத்தது.',
      order_ready: 'உங்கள் ஆர்டர் தயார்!',
      anything_else: 'வேறு ஏதாவது உதவி தேவையா?',
      goodbye: 'Tilapiya ஐ தேர்ந்தெடுத்ததற்கு நன்றி. மீண்டும் வாருங்கள்!',
      welcome: 'வரவேற்கிறோம்!',
      sorry: 'சிரமத்திற்கு மன்னிக்கவும்.',
      please_wait: 'தயவுசெய்து சிறிது நேரம் காத்திருங்கள்.',
    },
  };

  const lang = (language || 'en').toLowerCase();
  return phrases[lang] || phrases.en;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectLanguage,
  getLanguageName,
  detectAndTranslate,
  buildMultilingualSystemPrompt,
  getCommonPhrases,
};
