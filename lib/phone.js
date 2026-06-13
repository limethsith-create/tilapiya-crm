// Shared phone normalization for Tilapiya CRM.
// Rules: strip spaces/dashes; keep '+' prefix; leading '0' becomes '+94';
// otherwise prefix '+' (WhatsApp sends numbers without '+').

function normalizePhone(p) {
  if (p === null || p === undefined) return p;
  var s = String(p).replace(/[\s-]/g, '');
  if (s.length === 0) return s;
  if (s.charAt(0) === '+') return s;
  if (s.charAt(0) === '0') return '+94' + s.slice(1);
  return '+' + s;
}

module.exports = { normalizePhone };
