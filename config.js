/* =============================================================
 *  Paribesh Bandhu Jury App — configuration
 *  This is the ONLY file you normally need to edit.
 * ============================================================= */
window.APP_CONFIG = {
  // Paste the Apps Script Web App URL (ends in /exec).
  // Leave as-is to run in DEMO mode (data stays in this browser only).
  API_URL: 'https://script.google.com/macros/s/AKfycbyW0kFCoIT2H7c83g4WkOmN26IJeVo--A2VUHtjFJv0PeO07ldXD5n1CqEVa-f9HkER9Q/exec',

  // WhatsApp business number that replies with login codes (country code + number, no +)
  WHATSAPP_NUMBER: '919147375801',

  APP_NAME: 'Paribesh Bandhu',
  APP_SUBTITLE: 'Jury Portal',
  ORG_NAME: 'Mantras Foundation',
  ORG_URL: 'https://mantrasfoundation.org',

  // Photo compression (done on the phone before upload)
  PHOTO_MAX_SIDE: 1600,     // px, longest side
  PHOTO_QUALITY: 0.78,      // JPEG quality 0–1
  PHOTO_TARGET_KB: 450,     // tries to stay under this
  MAX_PHOTOS: 30,
  MAX_DOC_MB: 15,

  /* ----------------------------------------------------------
   *  FORM FIELDS — DRAFT, to be confirmed against the committee
   *  write-up. Add / remove / reorder freely.
   *  type: text | tel | email | number | date | textarea | select
   *  'memberName' and 'area' are used to name the Drive folder
   *  ("Name - Area") — keep those two keys.
   * ---------------------------------------------------------- */
  SECTIONS: [
    {
      title: 'Jury member',
      fields: [
        { key: 'memberName', label: 'Full name', type: 'text', required: true, prefill: 'name' },
        { key: 'phone', label: 'Mobile number', type: 'tel', required: true, prefill: 'phone' },
        { key: 'email', label: 'Email (optional)', type: 'email', prefill: 'email' }
      ]
    },
    {
      title: 'Committee & location',
      fields: [
        { key: 'committeeName', label: 'Committee name', type: 'text', required: true },
        { key: 'area', label: 'Area / location', type: 'text', required: true, hint: 'Used to name your folder' },
        { key: 'address', label: 'Address / landmark', type: 'textarea', rows: 2 }
      ]
    },
    {
      title: 'Participation details',
      fields: [
        { key: 'visitDate', label: 'Date of visit', type: 'date' },
        { key: 'participationDetails', label: 'Participation details', type: 'textarea', rows: 4, required: true,
          hint: 'What the committee did, scale of participation, notable observations' },
        { key: 'remarks', label: 'Jury remarks', type: 'textarea', rows: 3 }
      ]
    }
  ]
};
