// Vercel Serverless Function - WhatsApp Webhook for Tilapiya CRM
// Receives WhatsApp messages from Meta, uses GPT-4o Mini for smart replies

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'tilapiya_verify_2026';
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- TILAPIYA RESTAURANT KNOWLEDGE BASE ---
const RESTAURANT_INFO = `
You are the friendly WhatsApp assistant for Tilapiya Colombo, the best BYOB restaurant in Colombo, Sri Lanka.

ABOUT US:
- Full name: Tilapiya Colombo
- Tagline: "Dining & Socializing, By Friends For Friends"
- Location: 11B, MS 4 Mini Stand, Phillip Gunewardana Mawatha, Race Course Arcade, Colombo 07
- Phone: +94 77 949 4394 (also +94 77 178 7726)
- Email: info@tilapiyacolombo.lk
- Website: tilapiyacolombo.lk
- Instagram: @tilapiya_colombo
- Facebook: facebook.com/tilapiyacolombo
- TripAdvisor: Rated 4.8/5, ranked #85 of 902 restaurants in Colombo
- Open daily for lunch and dinner (lunch from 11:30 AM, dinner until 11:00 PM)

KEY FEATURES:
- FREE BYOB (Bring Your Own Bottle) with NO corkage fee
- Private dining rooms with karaoke
- Live band music EVERY day of the week
- Customized events and parties
- "All You Can Eat" menu available
- Buffet options available

OUR SIGNATURE DISH:
- Crispy Fried Whole Tilapia Fish & Chips (RS 490 per 100g) - our namesake dish with fried garlic, curry leaves, red chili, french fries, green salad & home-made sauces

MENU HIGHLIGHTS WITH PRICES:

BURGERS:
- The Yankee (Crispy Chicken & Cheese) - RS 1,650
- El Double (Grilled Beef & Cheese) - RS 1,950
- Holy Chunk (Belly Pork & Cheese) - RS 1,850

HEALTHY BOWLS:
- Chicken Bowl - RS 1,750
- Tuna Bowl - RS 1,850
- Tofu Bowl - RS 1,650
- Prawn Bowl - RS 1,950

EXECUTIVE LUNCH SET MENU:
- Seafood Set - RS 1,490
- Chicken Set - RS 1,490

SALADS & SOUPS:
- Greek Salad - RS 1,850
- Hawaiian Chicken Salad - RS 1,950
- Caesar Salad (Prawns/Chicken/Lobster) - RS 2,100
- Beef Bone Marrow Soup - RS 1,850
- Chicken Noodle Soup - RS 1,750
- Pepper Mutton Broth - RS 2,650
- Seafood Tom Yum Soup - RS 2,950
- Thai Spicy Beef Salad - RS 2,350
- Cream of Shiitake Mushroom Soup - RS 1,600

MAINS:
- Crispy Fried Whole Tilapia Fish & Chips - RS 490 per 100g
- Grilled Greek Chicken - RS 3,100
- Grilled Beef Fillet - RS 4,950
- Teriyaki Beef - RS 3,850
- Herb Marinated Pork Leg Steak - RS 2,950
- Teriyaki Pork Belly - RS 3,550
- Crispy Pork Knuckle - RS 750 per 100g
- Sizzling Thai Grilled Calamari - RS 2,950
- Grilled Tiger Prawns - RS 5,100
- Garlic Butter Crab (800g) - RS 4,500
- Singaporean Style Chilli Crab (800g) - RS 4,200
- Thai Crab Curry (800g) - RS 4,200
- Murex Mussel Shell-less (500g) - RS 4,950
- Sizzling Thai Octopus (500g) - RS 3,400
- Vegetable Tempura - RS 2,250
- Basil Pesto Couscous - RS 2,450

FRIED MEAT & SEAFOOD:
- Fried Pork (Large) - RS 2,950
- Fried Kochchi Beef - RS 3,350
- Fried Chicken (Large) - RS 2,700
- Karaage Chicken - RS 2,800
- Crispy Fried Calamari - RS 2,950
- Hot Butter Calamari (Large) - RS 2,950
- Battered Prawns (Large) - RS 2,950

ISLAND DELIGHTS (Sri Lankan Curry with Roast Paan or Pol Rotti + Pol Sambal):
- Red Chicken Curry - RS 2,950
- Black Pork Curry - RS 3,100
- Red Beef Curry - RS 3,300
- Red Mutton Curry - RS 4,100
- Red Prawns Curry - RS 3,950
- Jaffna Crab Curry - RS 4,100
- Tilapiya Fish Curry - RS 3,100

PASTA & RICE:
- Spaghetti Aglio e Olio - RS 2,650
- Spaghetti with Fresh Basil Pesto - RS 2,650
- Spaghetti Alle Vongole (Clams) - RS 3,450
- Fettuccine with Beef and White Truffle - RS 3,450
- Chicken Bolognese - RS 2,950
- Creamy Seafood Penne Pasta - RS 3,450
- Wok Fried Spicy Mixed Meat Rice - RS 2,950
- Spicy Chili Chicken Rice - RS 2,650

SIDE DISHES:
- Mixed Cheese Omelette - RS 1,950
- Sri Lankan Chicken Omelette - RS 1,650
- French Fries Regular RS 950 / Large RS 1,950
- Home-made Potato Wedges Regular RS 950 / Large RS 1,950
- Sauteed Garlic Mushroom - RS 750
- Garlic Rice / Egg Rice - RS 590
- Pol Rotti - RS 490
- Steamed Basmati Rice - RS 490
- Garlic Bread - RS 490
- Roasted Paan - RS 430

KIDS MENU (RS 1,450 each):
- Crispy Chicken Nuggets + Potato Wedges
- Spaghetti Beef Bolognese
- Chicken & Cheese Wrap

BEVERAGES:
- Mocktails RS 850-950
- Soft Drinks RS 350-1,450
- Fresh Juices RS 650-950
- Milkshakes RS 950
- Coffee RS 500-650

DESSERTS:
- Chocolate/White Chocolate Mousse - RS 690
- Ice Cream - RS 750-890

IMPORTANT RULES FOR YOUR RESPONSES:
1. Keep replies SHORT and friendly (max 3-4 sentences for simple questions)
2. Use WhatsApp-friendly formatting (no markdown, use simple text)
3. Always be warm and welcoming - you represent a premium restaurant
4. If someone wants to book a private event, give them the phone number
5. If someone has a complaint, apologize sincerely and say the team will follow up personally
6. Prices are in Sri Lankan Rupees (RS)
7. If you don't know something, say you'll check with the team and get back to them
8. For questions about allergens or dietary restrictions, recommend calling the restaurant directly
9. Reply in the same language the customer uses (Sinhala, Tamil, or English)
10. Never make up information that isn't in this knowledge base
`;

// --- SUPABASE HELPER ---
async function supabaseRequest(path, method, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', path, res.status, err);
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

// --- CUSTOMER MANAGEMENT ---
async function upsertCustomer(phone, name) {
  const existing = await supabaseRequest(
    'customers?phone=eq.' + encodeURIComponent(phone) + '&select=id,phone,name', 'GET'
  );
  if (existing && existing.length > 0) {
    await supabaseRequest('customers?id=eq.' + existing[0].id, 'PATCH',
      { last_contact: new Date().toISOString(), name: name || existing[0].name });
    return existing[0].id;
  }
  const created = await supabaseRequest('customers', 'POST', {
    phone, name: name || phone, segment: 'new'
  });
  return created && created[0] ? created[0].id : null;
}

// --- MESSAGE STORAGE ---
async function saveMessage(customerId, message, direction, intent) {
  return supabaseRequest('conversations', 'POST', {
    customer_id: customerId, direction, message,
    intent: intent || 'pending', timestamp: new Date().toISOString()
  });
}

// --- GET RECENT CONVERSATION HISTORY ---
async function getRecentMessages(customerId, limit) {
  limit = limit || 6;
  const data = await supabaseRequest(
    'conversations?customer_id=eq.' + customerId +
    '&order=timestamp.desc&limit=' + limit +
    '&select=direction,message,timestamp', 'GET'
  );
  if (!data || data.length === 0) return [];
  return data.reverse();
}

// --- DETECT MESSAGE INTENT (keyword-based, zero cost) ---
function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/^(hi|hello|hey|howdy|good morning|good evening|good afternoon|ayubowan|vanakkam|kohomada)/.test(lower)) return 'greeting';
  if (/menu|food|dish|eat|what do you (serve|have|offer)|price|cost|how much|rata|kema/.test(lower)) return 'menu';
  if (/where|location|address|direction|map|how to get|come there|situated|koheda/.test(lower)) return 'location';
  if (/hour|open|close|time|when|timing|what time/.test(lower)) return 'hours';
  if (/book|reserv|table|party|event|private|karaoke|celebrate|birthday|anniversary/.test(lower)) return 'booking';
  if (/byob|bring your own|bottle|corkage|alcohol|drink|liquor|beer|wine|arrack/.test(lower)) return 'byob';
  if (/complain|bad|terrible|worst|disappoint|angry|upset|rude|poor|refund|unacceptable/.test(lower)) return 'complaint';
  if (/thank|thanks|cheers|appreciate/.test(lower)) return 'thanks';
  return 'general';
}

// --- QUICK REPLIES (zero cost, no AI needed) ---
function getQuickReply(intent) {
  switch (intent) {
    case 'greeting':
      return "Hello! Welcome to Tilapiya Colombo!\n\nWe're the best BYOB restaurant in Colombo with FREE corkage, live band music daily, private dining rooms & karaoke!\n\nHow can I help you today? Ask me about our menu, location, events, or anything else!";
    case 'location':
      return "We're at Race Course Arcade, Colombo 07!\n\n11B, MS 4 Mini Stand, Phillip Gunewardana Mawatha, Race Course Ave, Colombo 00700\n\nCall us: +94 77 949 4394";
    case 'hours':
      return "We're open daily!\n\nLunch: from 11:30 AM\nDinner: until 11:00 PM\n\nLive band plays every night! See you soon!";
    case 'byob':
      return "Yes! We have a completely FREE BYOB policy!\n\nBring your own wine, beer, arrack - anything you like. ZERO corkage fee!\n\nThat's what makes Tilapiya special. Bring your favorite bottle and enjoy!";
    case 'booking':
      return "For private dining, events, parties & karaoke rooms, please call us directly!\n\n+94 77 949 4394\n\nWe can customize everything for your event - birthdays, anniversaries, corporate dinners, you name it!";
    case 'complaint':
      return "We're truly sorry to hear about your experience.\n\nYour feedback matters a lot to us. Our management team will personally follow up with you shortly.\n\nIf urgent, please call: +94 77 949 4394";
    case 'thanks':
      return "You're welcome! We hope to see you at Tilapiya soon!\n\nRemember - free BYOB, live music every night, and the best seafood in Colombo!";
    default:
      return null;
  }
}

// --- AI REPLY (Groq - Llama 3.1 8B, FREE) ---
async function getAIReply(customerMessage, conversationHistory) {
  if (!GROQ_API_KEY) {
    console.error('No GROQ_API_KEY set');
    return "Thank you for your message! Our team will get back to you shortly.\n\nCall us anytime: +94 77 949 4394";
  }
  try {
    const messages = [{ role: 'system', content: RESTAURANT_INFO }];
    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        messages.push({
          role: msg.direction === 'inbound' ? 'user' : 'assistant',
          content: msg.message
        });
      }
    }
    messages.push({ role: 'user', content: customerMessage });
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });
    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content;
    }
    console.error('Groq unexpected response:', JSON.stringify(data));
    return "Thank you for your message! Our team will get back to you shortly.\n\nCall us: +94 77 949 4394";
  } catch (err) {
    console.error('Groq error:', err);
    return "Thank you for your message! Our team will get back to you shortly.\n\nCall us: +94 77 949 4394";
  }
}

// --- SEND WHATSAPP MESSAGE ---
async function sendWhatsAppReply(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  try {
    await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'text',
        text: { body: text }
      })
    });
  } catch (e) { console.error('WhatsApp reply error:', e); }
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (!body || !body.entry) return res.status(200).json({ status: 'no entry' });

      for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field !== 'messages') continue;
          const value = change.value || {};
          const messages = value.messages || [];
          const contacts = value.contacts || [];

          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const contact = contacts[i] || {};
            const phone = msg.from;
            const name = contact.profile ? contact.profile.name : null;
            const text = msg.text ? msg.text.body : '[media]';

            const customerId = await upsertCustomer(phone, name);
            if (!customerId) continue;

            const intent = detectIntent(text);
            await saveMessage(customerId, text, 'inbound', intent);

            let reply = getQuickReply(intent);
            if (!reply) {
              const history = await getRecentMessages(customerId, 6);
              reply = await getAIReply(text, history);
            }

            await sendWhatsAppReply(phone, reply);
            await saveMessage(customerId, reply, 'outbound', intent);
          }
        }
      }
      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(200).json({ status: 'error', message: err.message });
    }
  }

  return res.status(405).send('Method not allowed');
};
