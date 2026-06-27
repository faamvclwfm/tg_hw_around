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

// Функція відправки повідомлень в Telegram
async function tgSend(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[TG] Error:', JSON.stringify(result));
    return result;
}

/**
 * 1. Сповіщення про зміну розкладу (дата або час у той самий день)
 */
async function sendScheduleChangeNotification(groupId, dateStr, oldTime, newTime, changeType) {
    try {
        const groupDoc = await db.collection('groups').doc(groupId).get();
        if (!groupDoc.exists) return;
        
        const groupData = groupDoc.data();
        const students = groupData.students || [];
        const groupName = groupData.name || 'Твоя група';

        for (const studentId of students) {
            const userDoc = await db.collection('users').doc(studentId).get();
            const chatId = userDoc.data()?.tgChatId;
            
            if (!chatId) continue;

            let message = '';
            
            if (changeType === 'time_change') {
                // Якщо перенесли на іншу годину в той самий день
                message = `⏰ *Зміна часу заняття!*\n\nЗаняття з предмета "${groupName}" на *${dateStr}* змінено.\n🕒 Старий час: ~${oldTime || 'не вказано'}~\n🟢 Новий час: *${newTime}*`;
            } else if (changeType === 'rescheduled') {
                // Якщо перенесли на інший день взагалі
                message = `📅 *Перенесення заняття!*\n\nЗаняття з предмета "${groupName}" перенесено на іншу дату.\n🗓 Нова дата: *${dateStr}*\n🕒 Час проведення: *${newTime}*`;
            } else if (changeType === 'cancelled') {
                message = `❌ *Заняття скасовано!*\n\nЗаняття з предмета "${groupName}" на *${dateStr}* було скасовано.`;
            }

            if (message) {
                await tgSend(chatId, message);
            }
        }
    } catch (e) {
        console.error('[Schedule Notification Error]', e);
    }
}

/**
 * 2. Вечірні нагадування про ДЗ напередодні заняття (о 17:30 через Cron Job)
 */
async function sendEveningReminders() {
    try {
        // Отримуємо завтрашню дату у форматі YYYY-MM-DD (локальний час сервера/запиту)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0]; 

        // Проходимося по всіх групах
        const groupsSnap = await db.collection('groups').get();

        for (const groupDoc of groupsSnap.docs) {
            const groupData = groupDoc.data();
            const schedule = groupData.schedule || {};
            const tomorrowLesson = schedule[tomorrowStr];

            // Перевіряємо, чи є на завтра активне заняття
            // (Статус 'scheduled' або 'rescheduled' автоматично враховує перенесені на завтра заняття)
            if (tomorrowLesson && (tomorrowLesson.status === 'scheduled' || tomorrowLesson.status === 'rescheduled')) {
                const students = groupData.students || [];
                const groupName = groupData.name || 'Твоя група';
                
                for (const studentId of students) {
                    const userDoc = await db.collection('users').doc(studentId).get();
                    const chatId = userDoc.data()?.tgChatId;
                    
                    if (chatId) {
                        const msg = `🔔 *Нагадування про ДЗ!*\n\nЗавтра (*${tomorrowStr}*) о *${tomorrowLesson.time}* у тебе відбудеться заняття з предмета "${groupName}".\n\n📚 Не забудь виконати та здати домашнє завдання у своєму особистому кабінеті!`;
                        await tgSend(chatId, msg);
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Evening Reminders Error]', e);
    }
}

/**
 * ГОЛОВНИЙ ОБРОБНИК ВЕБХУКУ (API ROUTE)
 */
export default async function handler(req, res) {
    // Обробка GET запиту (для Cron Job, який тригерить нагадування о 17:30)
    if (req.method === 'GET') {
        const action = req.query?.action;
        if (action === 'evening_reminders') {
            await sendEveningReminders();
            return res.status(200).send('Reminders processed');
        }
        return res.status(200).send('OK');
    }

    if (req.method !== 'POST') {
        return res.status(200).send('OK');
    }

    const action = req.query?.action || req.body?.action;

    // Обробка POST запиту від клієнтського JS (зміна дати/часу заняття в адмінці)
    if (action === 'schedule_change') {
        const { groupId, dateStr, oldTime, newTime, changeType } = req.body;
        if (groupId && dateStr) {
            await sendScheduleChangeNotification(groupId, dateStr, oldTime, newTime, changeType);
        }
        return res.status(200).send('Notification processed');
    }

    // Обробка стандартних повідомлень від Telegram (наприклад, старт чи профіль учня)
    let update;
    try {
        update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[Parse Error]', e.message);
        return res.status(200).send('OK');
    }

    try {
        if (update && update.message) {
            const chatId = update.message.chat.id;
            const text = update.message.text;

            if (text === '/start') {
                await tgSend(chatId, '👋 Привіт! Я твій навчальний бот-асистент. Тут ти отримуватимеш нагадування про заняття та домашні завдання.');
            }
        }
    } catch (e) {
        console.error('[Handler Error]', e.message);
    }

    return res.status(200).send('OK');
}