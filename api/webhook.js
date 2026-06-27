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

// ===== ВИПРАВЛЕННЯ 1: MarkdownV2 замість Markdown =====
// Markdown (v1) не підтримує ~закреслення~ та має баги з екрануванням.
// MarkdownV2 — актуальний стандарт Telegram.
// Спецсимволи _ * [ ] ( ) ~ ` > # + - = | { } . ! потрібно екранувати.
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function tgSend(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'MarkdownV2', // ВИПРАВЛЕНО: було 'Markdown'
            ...extra,
        }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[TG] Error:', JSON.stringify(result));
    return result;
}

// ===== ВИПРАВЛЕННЯ 2: Реєстрація chatId при /start =====
// Без збереження tgChatId у Firestore юзер ніколи не отримає нагадувань.
async function handleStart(chatId, from) {
    try {
        const userId = String(from.id);

        // Зберігаємо/оновлюємо tgChatId в колекції users
        await db.collection('users').doc(userId).set(
            {
                tgChatId: chatId,
                tgUsername: from.username || null,
                tgFirstName: from.first_name || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true } // merge: true — не перезаписуємо решту полів
        );

        const name = escapeMarkdown(from.first_name || 'Учню');
        await tgSend(
            chatId,
            `👋 Привіт, *${name}*\\!\n\nЯ твій навчальний бот\\-асистент\\. Тут ти отримуватимеш нагадування про заняття та домашні завдання\\.\n\n📌 Доступні команди:\n/start \\— перезапустити бота\n/help \\— допомога`
        );
    } catch (e) {
        console.error('[handleStart Error]', e);
    }
}

// ===== ВИПРАВЛЕННЯ 3: Обробка /help та невідомих команд =====
async function handleHelp(chatId) {
    await tgSend(
        chatId,
        `ℹ️ *Довідка*\n\n/start \\— реєстрація та привітання\n/help \\— ця довідка\n\nНагадування про заняття та ДЗ надходять автоматично напередодні ввечері\\.`
    );
}

async function handleUnknown(chatId, text) {
    const safe = escapeMarkdown(text);
    await tgSend(
        chatId,
        `🤷 Не розумію команду: \`${safe}\`\n\nСпробуй /help для списку доступних команд\\.`
    );
}

/**
 * 1. Сповіщення про зміну розкладу
 */
async function sendScheduleChangeNotification(groupId, dateStr, oldTime, newTime, changeType) {
    try {
        const groupDoc = await db.collection('groups').doc(groupId).get();
        if (!groupDoc.exists) return;

        const groupData = groupDoc.data();
        const students = groupData.students || [];
        const groupName = escapeMarkdown(groupData.name || 'Твоя група');
        const safeDateStr = escapeMarkdown(dateStr);
        const safeOldTime = escapeMarkdown(oldTime || 'не вказано');
        const safeNewTime = escapeMarkdown(newTime);

        for (const studentId of students) {
            const userDoc = await db.collection('users').doc(studentId).get();
            const chatId = userDoc.data()?.tgChatId;
            if (!chatId) continue;

            let message = '';

            if (changeType === 'time_change') {
                message = `⏰ *Зміна часу заняття\\!*\n\nЗаняття з предмета "${groupName}" на *${safeDateStr}* змінено\\.\n🕒 Старий час: ~${safeOldTime}~\n🟢 Новий час: *${safeNewTime}*`;
            } else if (changeType === 'rescheduled') {
                message = `📅 *Перенесення заняття\\!*\n\nЗаняття з предмета "${groupName}" перенесено на іншу дату\\.\n🗓 Нова дата: *${safeDateStr}*\n🕒 Час проведення: *${safeNewTime}*`;
            } else if (changeType === 'cancelled') {
                message = `❌ *Заняття скасовано\\!*\n\nЗаняття з предмета "${groupName}" на *${safeDateStr}* було скасовано\\.`;
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
 * 2. Вечірні нагадування про ДЗ (Cron Job о 17:30)
 */
async function sendEveningReminders() {
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const groupsSnap = await db.collection('groups').get();

        for (const groupDoc of groupsSnap.docs) {
            const groupData = groupDoc.data();
            const schedule = groupData.schedule || {};
            const tomorrowLesson = schedule[tomorrowStr];

            if (
                tomorrowLesson &&
                (tomorrowLesson.status === 'scheduled' || tomorrowLesson.status === 'rescheduled')
            ) {
                const students = groupData.students || [];
                const groupName = escapeMarkdown(groupData.name || 'Твоя група');
                const safeDate = escapeMarkdown(tomorrowStr);
                const safeTime = escapeMarkdown(tomorrowLesson.time);

                for (const studentId of students) {
                    const userDoc = await db.collection('users').doc(studentId).get();
                    const chatId = userDoc.data()?.tgChatId;

                    if (chatId) {
                        const msg = `🔔 *Нагадування про ДЗ\\!*\n\nЗавтра \\(*${safeDate}*\\) о *${safeTime}* у тебе відбудеться заняття з предмета "${groupName}"\\.\n\n📚 Не забудь виконати та здати домашнє завдання у своєму особистому кабінеті\\!`;
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
 * ГОЛОВНИЙ ОБРОБНИК ВЕБХУКУ
 */
export default async function handler(req, res) {
    // GET — для Cron Job
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

    // POST від адмінки (зміна розкладу)
    if (action === 'schedule_change') {
        const { groupId, dateStr, oldTime, newTime, changeType } = req.body;
        if (groupId && dateStr) {
            await sendScheduleChangeNotification(groupId, dateStr, oldTime, newTime, changeType);
        }
        return res.status(200).send('Notification processed');
    }

    // POST від Telegram
    let update;
    try {
        update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[Parse Error]', e.message);
        return res.status(200).send('OK');
    }

    try {
        if (update?.message) {
            const chatId = update.message.chat.id;
            const from = update.message.from || {};
            const text = (update.message.text || '').trim();

            // ===== ВИПРАВЛЕННЯ 3: Розширений обробник команд =====
            if (text === '/start') {
                await handleStart(chatId, from);
            } else if (text === '/help') {
                await handleHelp(chatId);
            } else if (text.startsWith('/')) {
                // Невідома команда — підказуємо юзеру
                await handleUnknown(chatId, text);
            } else {
                // Довільне текстове повідомлення (не команда)
                // Тут можна додати логіку або просто ігнорувати
                // await tgSend(chatId, 'Напиши /help для списку команд\\.');
            }
        }

        // Обробка натискань на inline-кнопки (callback_query)
        if (update?.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message?.chat?.id;
            const data = callbackQuery.data;

            // Підтвердження отримання callback (обов'язково!)
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callbackQuery.id }),
            });

            // TODO: обробляй data тут залежно від твоїх кнопок
            console.log('[Callback]', data, 'from chat', chatId);
        }
    } catch (e) {
        console.error('[Handler Error]', e.message, e.stack);
    }

    return res.status(200).send('OK');
}