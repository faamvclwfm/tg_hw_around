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

async function tgSend(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[TG] Error:', JSON.stringify(result));
    return result;
}

function getTomorrowDateStr() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getTomorrowDow() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    let dow = tomorrow.getDay();
    if (dow === 0) dow = 7;
    return dow;
}

function formatDate(dateStr) {
    const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

async function getActiveHomeworks(groupId, userId) {
    const [assignSnap, completedSnap] = await Promise.all([
        db.collection('assignments').where('groupId', '==', groupId).get(),
        db.collection('completed_homeworks').where('groupId', '==', groupId).where('userId', '==', userId).get()
    ]);

    if (assignSnap.empty) return [];

    const submittedIds = new Set();
    completedSnap.forEach(d => submittedIds.add(d.data().assignmentId));

    const active = [];
    assignSnap.forEach(d => {
        if (!submittedIds.has(d.id)) active.push({ id: d.id, ...d.data() });
    });

    active.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    return active;
}

async function sendReminders() {
    const tomorrowStr = getTomorrowDateStr();
    const tomorrowDow = getTomorrowDow();

    console.log(`[Reminders] Running for tomorrow: ${tomorrowStr} (dow=${tomorrowDow})`);

    const groupsSnap = await db.collection('groups').get();
    if (groupsSnap.empty) return;

    const remindersToSend = [];

    groupsSnap.forEach(groupDoc => {
        const groupId = groupDoc.id;
        const data = groupDoc.data();
        const schedule = data.schedule || {};
        const recurring = schedule.recurring || [];
        const exceptions = schedule.exceptions || {};
        const members = data.members || [];

        if (members.length === 0) return;

        let tomorrowLessons = [];

        const exception = exceptions[tomorrowStr];
        if (exception) {
            if (exception.list && Array.isArray(exception.list)) {
                tomorrowLessons = exception.list.filter(l => l.status !== 'cancelled' && l.status !== 'rescheduled');
            } else if (exception.status && exception.status !== 'cancelled' && exception.status !== 'rescheduled' && exception.status !== 'none') {
                tomorrowLessons = [{ time: exception.time || '—', status: exception.status }];
            }
        } else {
            const rec = recurring.find(r => r.day === tomorrowDow);
            if (rec) {
                tomorrowLessons = [{ time: rec.time || '—', status: 'scheduled' }];
            }
        }

        if (tomorrowLessons.length === 0) return;

        const timeStr = tomorrowLessons.map(l => l.time).join(', ');

        members.forEach(userId => {
            remindersToSend.push({ groupId, userId, tomorrowStr, timeStr });
        });
    });

    if (remindersToSend.length === 0) {
        console.log('[Reminders] No lessons tomorrow for any group.');
        return;
    }

    const uniqueUserIds = [...new Set(remindersToSend.map(r => r.userId))];

    const usersMap = {};
    const batchSize = 10;
    for (let i = 0; i < uniqueUserIds.length; i += batchSize) {
        const chunk = uniqueUserIds.slice(i, i + batchSize);
        const snap = await db.collection('users')
            .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
            .get();
        snap.forEach(doc => {
            usersMap[doc.id] = { uid: doc.id, ...doc.data() };
        });
    }

    const sends = [];

    for (const reminder of remindersToSend) {
        const user = usersMap[reminder.userId];
        if (!user || !user.tgChatId) continue;

        const activeHws = await getActiveHomeworks(reminder.groupId, reminder.userId).catch(() => []);

        let hwBlock = '';
        if (activeHws.length > 0) {
            const hwLines = activeHws.slice(0, 3).map((hw, i) => {
                const count = (hw.requiredTests || []).length;
                return `  ${i + 1}. 📌 *${hw.title || 'Без назви'}* (${count} тестів)`;
            });
            hwBlock = `\n\n📚 *Активні домашні завдання:*\n${hwLines.join('\n')}`;
            if (activeHws.length > 3) hwBlock += `\n  ...і ще ${activeHws.length - 3}`;
            hwBlock += `\n\n👉 [Виконати в кабінеті](${CABINET_URL})`;
        } else {
            hwBlock = '\n\n✅ Активних ДЗ немає — можна йти на заняття спокійно!';
        }

        const text =
            `🔔 *Нагадування про завтрашнє заняття*\n\n` +
            `📅 *${formatDate(reminder.tomorrowStr)}* о *${reminder.timeStr}*` +
            hwBlock;

        sends.push(
            tgSend(user.tgChatId, text, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }).catch(e => console.error(`[TG] Failed to send to ${user.tgChatId}:`, e.message))
        );
    }

    await Promise.allSettled(sends);
    console.log(`[Reminders] Sent ${sends.length} reminders.`);
}

module.exports = async function handler(req, res) {
    const secret = req.headers['x-cron-secret'];
    if (secret !== process.env.CRON_SECRET) {
        res.status(401).send('Unauthorized');
        return;
    }

    try {
        await sendReminders();
        res.status(200).send('OK');
    } catch (e) {
        console.error('[Cron Error]', e.message, e.stack);
        res.status(500).send('Error');
    }
};