const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

const db = admin.firestore();
const BOT_TOKEN = process.env.BOT_TOKEN;
const CABINET_URL = 'https://diagnostictestresults-9f6ac.web.app/';

const RESULTS_COLLECTIONS = [
    'results_mathQuizDiagnosticNEW',
    'results_test_completed',
    ...Array.from({ length: 6 },  (_, i) => `results_HOMEWORKTHEME${i + 1}`),
    ...Array.from({ length: 2 },  (_, i) => `results_HOMEWORKTHEME${i + 9}`),
    ...Array.from({ length: 92 }, (_, i) => `results_HOMEWORKTHEME${i + 12}`),
    'results_KLACALKATHEME12',
    ...Array.from({ length: 4 },  (_, i) => `results_KLACALKATHEME${i + 17}`),
    ...Array.from({ length: 20 }, (_, i) => `results_LESSON${i + 19}THEME`),
    'results_SUMMARYTEST1',
    'results_SUMMARYTEST2',
    ...Array.from({ length: 7 },  (_, i) => `results_PRACTICE${i + 1}`),
    ...Array.from({ length: 40 }, (_, i) => `results_ENGLISHWORDSQUIZ${i + 1}`),
    'results_INTERMEDIATETEST1',
    'results_INTERMEDIATETEST2',
    ...Array.from({ length: 5 },  (_, i) => `results_NMTTEST${i + 1}`),
    ...Array.from({ length: 30 }, (_, i) => `results_HISTORYTEST${i + 1}`),
    ...Array.from({ length: 40 }, (_, i) => `results_UKRAINIAN${i + 1}`),
    ...Array.from({ length: 21 }, (_, i) => `results_CHINESE${i + 1}`),
];

async function tgSend(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const result = await r.json();
    return result;
}

async function findUserByChatId(chatId) {
    const snap = await db.collection('users').where('tgChatId', '==', String(chatId)).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const userData = { uid: doc.id, ...doc.data() };

    if (!userData.groupId) {
        const groupSnap = await db.collection('groups').where('members', 'array-contains', doc.id).limit(1).get();
        if (!groupSnap.empty) {
            userData.groupId = groupSnap.docs[0].id;
            await db.collection('users').doc(doc.id).set({ groupId: userData.groupId }, { merge: true });
        }
    }

    return userData;
}

async function getNextLessons(groupId, count = 5) {
    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) return [];

    const schedule = groupDoc.data().schedule || {};
    const recurring = schedule.recurring || [];
    const exceptions = schedule.exceptions || {};

    const lessons = [];
    const today = new Date();

    for (let i = 0; i < 30 && lessons.length < count; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);

        let dow = date.getDay();
        if (dow === 0) dow = 7;

        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const exception = exceptions[dateStr];

        if (exception) {
            if (exception.list && Array.isArray(exception.list)) {
                const activeLessons = exception.list.filter(l => l.status !== 'cancelled' && l.status !== 'rescheduled');
                activeLessons.forEach(l => {
                    lessons.push({ dateStr, time: l.time || '—', status: l.status });
                });
                continue;
            }
            if (exception.status === 'cancelled' || exception.status === 'rescheduled') continue;
            if (['scheduled', 'conducted', 'milestone'].includes(exception.status)) {
                lessons.push({ dateStr, time: exception.time || '—', status: exception.status });
                continue;
            }
            if (exception.status === 'none') continue;
        }

        const rec = recurring.find(r => r.day === dow);
        if (rec) {
            lessons.push({ dateStr, time: rec.time || '—', status: 'scheduled' });
        }
    }

    return lessons.slice(0, count);
}

async function getActiveHomeworks(groupId, userId) {
    const snap = await db.collection('assignments').where('groupId', '==', groupId).get();
    if (snap.empty) return [];

    const completedSnap = await db.collection('completed_homeworks').where('groupId', '==', groupId).where('userId', '==', userId).get();

    const submittedIds = new Set();
    completedSnap.forEach(d => submittedIds.add(d.data().assignmentId));

    const active = [];
    snap.forEach(d => {
        if (!submittedIds.has(d.id)) {
            active.push({ id: d.id, ...d.data() });
        }
    });

    active.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    return active.slice(0, 5);
}

async function getProgress(userId) {
    let totalScore = 0;
    let totalMax = 0;
    let count = 0;

    const batchSize = 10;
    const batches = [];
    for (let i = 0; i < RESULTS_COLLECTIONS.length; i += batchSize) {
        batches.push(RESULTS_COLLECTIONS.slice(i, i + batchSize));
    }

    for (const batch of batches) {
        const snaps = await Promise.all(
            batch.map(col => db.collection(col).where('userId', '==', userId).get().catch(() => null))
        );

        snaps.forEach(snap => {
            if (!snap || snap.empty) return;
            snap.forEach(doc => {
                const data = doc.data();
                const score = Number(data.testResult ?? data.score ?? 0);
                const max   = Number(data.maxScore ?? data.testQuestionsQuantity ?? 0);
                if (max > 0) {
                    totalScore += score;
                    totalMax   += max;
                    count++;
                }
            });
        });
    }

    const percent = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    return { count, percent };
}

function formatDate(dateStr) {
    const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: 'Мій абонемент 💳' }, { text: 'Домашні завдання 📚' }],
        [{ text: 'Розклад 📅' },        { text: 'Мій прогрес 📊' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
};

async function handleScheduleChange(payload) {
    const { groupId, dateStr, oldTime, newTime, changeType } = payload;
    if (!groupId || !dateStr) return;

    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) return;

    const members = groupDoc.data().members || [];
    if (members.length === 0) return;

    const usersSnap = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', members.slice(0, 10)).get();

    const formattedDate = formatDate(dateStr);

    let text = '';
    if (changeType === 'time_change') {
        text = `⏰ *Зміна часу заняття*\n\n📅 Дата: *${formattedDate}*\n🕐 Старий час: ${oldTime}\n🕑 Новий час: *${newTime}*\n\nПеревір свій розклад у кабінеті 👇\n${CABINET_URL}`;
    } else if (changeType === 'rescheduled') {
        text = `🔄 *Заняття перенесено*\n\n📅 Нова дата: *${formattedDate}*\n🕑 Час: *${newTime || oldTime}*\n\nПеревір свій розклад у кабінеті 👇\n${CABINET_URL}`;
    } else if (changeType === 'cancelled') {
        text = `❌ *Заняття скасовано*\n\n📅 Дата: *${formattedDate}*\n🕐 Час: ${oldTime}\n\nПеревір свій розклад у кабінеті 👇\n${CABINET_URL}`;
    } else {
        return;
    }

    const sends = [];
    usersSnap.forEach(doc => {
        const chatId = doc.data().tgChatId;
        if (chatId) {
            sends.push(tgSend(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD }));
        }
    });

    if (members.length > 10) {
        const extraSnap = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', members.slice(10, 30)).get();
        extraSnap.forEach(doc => {
            const chatId = doc.data().tgChatId;
            if (chatId) {
                sends.push(tgSend(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD }));
            }
        });
    }

    await Promise.allSettled(sends);
}

async function handleUpdate(update) {
    let chatId, text = '';

    if (update?.message?.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update?.callback_query?.data) {
        chatId = update.callback_query.message.chat.id;
        text = update.callback_query.data.trim();
    } else {
        return;
    }

    if (text.startsWith('/start')) {
        const userId = text.split(' ')[1];
        if (userId) {
            await db.collection('users').doc(userId).set({ tgChatId: String(chatId) }, { merge: true });
        }

        await tgSend(chatId, "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nОбирай що тебе цікавить 👇", { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
        return;
    }

    const t = text.toLowerCase();
    const isAbonement = t.includes('абонемент') || text.startsWith('/subscription');
    const isHomework  = t.includes('домашн')    || text.startsWith('/homework');
    const isSchedule  = t.includes('розклад')   || text.startsWith('/schedule');
    const isProgress  = t.includes('прогрес')   || text.startsWith('/progress');

    if (!isAbonement && !isHomework && !isSchedule && !isProgress) {
        await tgSend(chatId, 'Обирай що тебе цікавить 👇', { reply_markup: MAIN_KEYBOARD });
        return;
    }

    const userData = await findUserByChatId(chatId);

    if (!userData) {
        await tgSend(chatId, "❌ Акаунт не підв'язано.\n\nПерейди в особистий кабінет і натисни кнопку підключення Telegram.", { reply_markup: MAIN_KEYBOARD });
        return;
    }

    if (isAbonement) {
        const sub = userData.subscription;
        if (!sub) {
            await tgSend(chatId, '📋 Абонемент ще не заповнений вчителем.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const name     = userData.name || userData.email || 'Учень';
        const paid     = Number(sub.paid     || 0);
        const attended = Number(sub.attended || 0);
        const left     = Math.max(0, paid - attended);
        const next     = sub.nextPayment ? formatDate(sub.nextPayment) : 'не вказано';
        const price    = Number(sub.pricePerLesson || 0);
        const sum      = price * paid;
        const priceLine = price > 0 ? `\n💰 Сума абонементу: \`${sum} грн\`` : '';
        const warning  = left === 0 ? '\n\n⚠️ *Поповни абонемент!*' : left <= 2 ? `\n\n⚡ Залишилось лише ${left} — скоро поповнити.` : '';

        await tgSend(chatId, `💳 *АБОНЕМЕНТ*\n\n👤 ${name}\n▬▬▬▬▬▬▬▬▬▬\n🍏 Оплачено:   \`${paid}\`\n👟 Відвідано:  \`${attended}\`\n🔥 Залишилось: \`${left}\`${priceLine}\n▬▬▬▬▬▬▬▬▬▬\n📅 Наступна оплата: *${next}*` + warning, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
        return;
    }

    const groupId = userData.groupId;

    if (isHomework) {
        if (!groupId) {
            await tgSend(chatId, '📭 Тебе ще не додано до жодного класу.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const hws = await getActiveHomeworks(groupId, userData.uid);

        if (hws.length === 0) {
            await tgSend(chatId, '✅ Активних домашніх завдань немає. Так тримати!', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const lines = hws.map((hw, i) => {
            const count = (hw.requiredTests || []).length;
            return `${i + 1}. 📌 *${hw.title || 'Без назви'}*\n    Тестів: ${count}`;
        });

        await tgSend(chatId, `📚 *Активні домашні завдання:*\n\n${lines.join('\n\n')}\n\n👉 [Перейти в кабінет](${CABINET_URL})`, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD });
        return;
    }

    if (isSchedule) {
        if (!groupId) {
            await tgSend(chatId, '📭 Тебе ще не додано до жодного класу.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const lessons = await getNextLessons(groupId);

        if (lessons.length === 0) {
            await tgSend(chatId, '📅 Найближчих занять не знайдено.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const emoji = { scheduled: '📍', conducted: '✅', milestone: '🚩' };
        const lines = lessons.map(l => `${emoji[l.status] || '📍'} *${formatDate(l.dateStr)}* — ${l.time}`);

        await tgSend(chatId, `📅 *Найближчі заняття:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
        return;
    }

    if (isProgress) {
        const { count, percent } = await getProgress(userData.uid);
        const bar     = Math.round(percent / 10);
        const filled  = '🟩'.repeat(bar);
        const empty   = '⬜'.repeat(10 - bar);
        const comment = percent >= 80 ? '🔥 Чудовий результат!' : percent >= 50 ? '💪 Непогано, є куди рости!' : '📈 Практикуйся більше!';

        await tgSend(chatId, `📊 *Мій прогрес*\n\nТестів пройдено: *${count}*\nСередній результат: *${percent}%*\n\n${filled}${empty}\n\n${comment}\n\n👉 [Детально в кабінеті](${CABINET_URL})`, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD });
        return;
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(200).send('OK');
        return;
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        res.status(200).send('OK');
        return;
    }

    const action = req.query?.action || '';

    if (action === 'schedule_change') {
        try {
            await handleScheduleChange(body);
        } catch (e) {}
        res.status(200).send('OK');
        return;
    }

    try {
        await handleUpdate(body);
    } catch (e) {
        const chatId = body?.message?.chat?.id || body?.callback_query?.message?.chat?.id;
        if (chatId) {
            try { await tgSend(chatId, '⚠️ Сталася помилка. Спробуй ще раз.', { reply_markup: MAIN_KEYBOARD }); } catch (_) {}
        }
    }

    res.status(200).send('OK');
};