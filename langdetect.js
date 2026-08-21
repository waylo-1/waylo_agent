/**
 * Language detection utility for Waylo
 * Detects Indian languages by Unicode script ranges
 */

// Common Marathi words to distinguish from Hindi (both use Devanagari script)
const marathiWords = [
  'आहे', 'आहेत', 'होते', 'होता', 'काय', 'कसे', 'कसं', 'कुठे', 
  'तुम्ही', 'तुमचा', 'माझा', 'माझे', 'मला', 'मी', 'तुला'
];

/**
 * Detects the language of input text based on Unicode script ranges
 * @param {string} text - The text to analyze
 * @returns {string} Language code (hi, en, ta, te, bn, mr, gu, kn, ml, pa)
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') {
    return 'en';
  }

  const trimmedText = text.trim();
  
  if (trimmedText.length === 0) {
    return 'en';
  }

  // Check for Tamil script
  if (/[\u0B80-\u0BFF]/.test(trimmedText)) {
    return 'ta';
  }

  // Check for Telugu script
  if (/[\u0C00-\u0C7F]/.test(trimmedText)) {
    return 'te';
  }

  // Check for Bengali script
  if (/[\u0980-\u09FF]/.test(trimmedText)) {
    return 'bn';
  }

  // Check for Gujarati script
  if (/[\u0A80-\u0AFF]/.test(trimmedText)) {
    return 'gu';
  }

  // Check for Kannada script
  if (/[\u0C80-\u0CFF]/.test(trimmedText)) {
    return 'kn';
  }

  // Check for Malayalam script
  if (/[\u0D00-\u0D7F]/.test(trimmedText)) {
    return 'ml';
  }

  // Check for Punjabi/Gurmukhi script
  if (/[\u0A00-\u0A7F]/.test(trimmedText)) {
    return 'pa';
  }

  // Check for Devanagari script (Hindi or Marathi)
  if (/[\u0900-\u097F]/.test(trimmedText)) {
    // Check if text contains common Marathi words
    const lowerText = trimmedText.toLowerCase();
    const hasMarathiWords = marathiWords.some(word => lowerText.includes(word));
    
    return hasMarathiWords ? 'mr' : 'hi';
  }

  // Default to English if no Indian script detected
  return 'en';
}

module.exports = { detectLanguage };
