/* =============================================================
 *  Paribesh Bandhu Jury App — configuration
 *  This is the ONLY file you normally need to edit.
 * ============================================================= */
window.APP_CONFIG = {
  // Paste the Apps Script Web App URL (ends in /exec).
  // Leave as-is to run in DEMO mode (data stays in this browser only).
  API_URL: 'https://script.google.com/macros/s/AKfycbyPzjclmWpHI_CaPl2-ilOYRU9T3Hnm-aYeilOD4mijLAStjreANOPc407gBpzE2Qhq/exec',

  APP_NAME: 'Paribesh Bandhu',
  APP_SUBTITLE: 'Jury Portal',
  ORG_NAME: 'Mantras Foundation',
  ORG_URL: 'https://mantrasfoundation.org',

  // Photo compression (done on the phone before upload)
  PHOTO_MAX_SIDE: 1600,     // px, longest side
  PHOTO_QUALITY: 0.78,      // JPEG quality 0–1
  PHOTO_TARGET_KB: 450,     // tries to stay under this
  MAX_PHOTOS: 15,           // per committee form
  MAX_VIDEOS: 8,            // per committee form
  MAX_VIDEO_MB: 800,        // per video (keep in step with Code.gs)
  MEMBER_QUOTA_MB: 4096,    // storage per jury member, shown in the app (Code.gs enforces it)

  // Videos are compressed on the phone before upload when the browser supports it (WebCodecs).
  // Where it doesn't (or compression would not save much), the original is uploaded unchanged.
  VIDEO_COMPRESS: {
    enabled: true,
    overMB: 25,             // only compress videos bigger than this
    maxSide: 1280,          // longest side after compression (1280 = 720p)
    bitrate: 2500000        // video bitrate in bits/s (≈ 19 MB per minute)
  },
  MEDIABUNNY_URL: 'https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/dist/bundles/mediabunny.min.mjs',
  MAX_DOC_MB: 15,

  /* ----------------------------------------------------------
   *  FORM FIELDS — DRAFT, to be confirmed against the committee
   *  write-up. Add / remove / reorder freely.
   *  type: text | tel | email | number | date | textarea | select
   *  'committeeName' and 'area' are used to name each committee's
   *  Drive folder ("Committee - Area") — keep those two keys.
   * ---------------------------------------------------------- */
  SECTIONS: [
    {
      title: 'Jury member',
      fields: [
        { key: 'memberName', label: 'Full name', type: 'text', required: true, prefill: 'name' },
        { key: 'phone', label: 'Mobile number', type: 'tel', required: true, prefill: 'phone' },
        { key: 'email', label: 'Email (optional)', type: 'email', prefill: 'contactEmail' }
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
    },
    {
      // Optional marks. Keys must stay 'score_<letter>'; keep the max values in step with SCORE_MAX in Code.gs.
      title: 'Marks (optional)',
      scoring: true,
      hint: 'Fill in only the sections you have assessed — you can leave any of these blank.',
      fields: [
        { key: 'score_A', label: 'A. Eco-Friendly Idol & Puja Materials', type: 'number', max: 100 },
        { key: 'score_B', label: 'B. Eco-Friendly Pandal & Decoration', type: 'number', max: 120 },
        { key: 'score_C', label: 'C. Waste Management & Circularity', type: 'number', max: 160 },
        { key: 'score_D', label: 'D. Water Conservation & Sanitation', type: 'number', max: 90 },
        { key: 'score_E', label: 'E. Energy Conservation & Low-Carbon Practices', type: 'number', max: 90 },
        { key: 'score_F', label: 'F. Plastic-Free & Sustainable Vendor', type: 'number', max: 80 },
        { key: 'score_G', label: 'G. Management Greenery, Trees & Biodiversity', type: 'number', max: 60 },
        { key: 'score_H', label: 'H. Environmental Awareness & Community', type: 'number', max: 50 },
        { key: 'score_I', label: 'I. Action Crowd Management & Traffic Flow', type: 'number', max: 80 },
        { key: 'score_J', label: 'J. Fire, Emergency & Escape Safety', type: 'number', max: 100 },
        { key: 'score_K', label: 'K. Accessibility & Inclusiveness', type: 'number', max: 40 },
        { key: 'score_L', label: 'L. Noise & Air Pollution Control', type: 'number', max: 30 }
      ]
    }
  ]
};
