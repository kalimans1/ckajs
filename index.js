require('dotenv').config();

const { Client, GatewayIntentBits, Routes, PermissionFlagsBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const MESSAGE_IDS_FILE = './message_ids.json';
const SIX_HOURS = 6 * 60 * 60 * 1000;

if (!TOKEN) {
    console.error('HATA: DISCORD_TOKEN .env dosyasında ayarlanmamış!');
    process.exit(1);
}

let guilds = {};
try {
    guilds = JSON.parse(fs.readFileSync('./guilds.json', 'utf8'));
} catch (err) {
    console.error('HATA: guilds.json okunamadı:', err.message);
    process.exit(1);
}

if (Object.keys(guilds).length === 0) {
    console.error('HATA: guilds.json içinde hiç sunucu tanımlanmamış!');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const rest = new REST({ version: '10' }).setToken(TOKEN);

const selectionMsg = require('./secme_mesaji.json');
const afterSelectionMsg = require('./sectiktensonra.json');
const claimedMsg = require('./claimed.json');
const claimed2Msg = require('./claimed2.json');

function getComponents(data) {
    return data.backups[0].messages[0].data.components;
}

function cleanComponent(comp, claimUrl) {
    const c = { ...comp };
    if (c.type === 2 && c.url) {
        delete c.custom_id;
        if (claimUrl) c.url = claimUrl;
    }
    if (c.components) {
        c.components = c.components.map(child => cleanComponent(child, claimUrl));
    }
    return c;
}

function cleanComponents(components, claimUrl) {
    return components.map(comp => cleanComponent(comp, claimUrl));
}

async function sendComponentsV2(channelId, components, claimUrl) {
    return rest.post(Routes.channelMessages(channelId), {
        body: {
            flags: 32768,
            components: cleanComponents(components, claimUrl)
        }
    });
}

function loadMessageIds() {
    try {
        if (fs.existsSync(MESSAGE_IDS_FILE)) {
            return JSON.parse(fs.readFileSync(MESSAGE_IDS_FILE, 'utf8'));
        }
    } catch {}
    return {};
}

function saveMessageIds(ids) {
    try {
        fs.writeFileSync(MESSAGE_IDS_FILE, JSON.stringify(ids, null, 2), 'utf8');
    } catch (err) {
        console.error('Mesaj IDleri kaydedilemedi:', err.message);
    }
}

async function deleteOldMessage(channelId, messageId) {
    if (!messageId) return;
    try {
        await rest.delete(Routes.channelMessage(channelId, messageId));
        console.log(`[${channelId}] Eski mesaj silindi (ID: ${messageId})`);
    } catch (err) {
        console.warn(`[${channelId}] Eski mesaj silinemedi (ID: ${messageId}):`, err.message);
    }
}

async function sendSelectionMessage(guildId, config) {
    const components = getComponents(selectionMsg);
    const result = await sendComponentsV2(config.selection_channel_id, components, config.claim_url);
    const messageId = result.id;

    const ids = loadMessageIds();
    ids[guildId] = messageId;
    saveMessageIds(ids);

    console.log(`[Sunucu: ${guildId}] Seçme mesajı gönderildi (ID: ${messageId})`);
    return messageId;
}

async function refreshSelectionMessage(guildId, config) {
    const ids = loadMessageIds();
    const oldId = ids[guildId] || null;
    await deleteOldMessage(config.selection_channel_id, oldId);
    await sendSelectionMessage(guildId, config);
}

async function refreshAllGuilds() {
    for (const [guildId, config] of Object.entries(guilds)) {
        try {
            await refreshSelectionMessage(guildId, config);
        } catch (err) {
            console.error(`[Sunucu: ${guildId}] Yenileme hatası:`, err.message);
        }
    }
}

client.on('clientReady', async () => {
    console.log(`✅ Bot hazır: ${client.user.tag}`);
    console.log(`📋 Yüklenen sunucular: ${Object.keys(guilds).join(', ')}`);

    await refreshAllGuilds();

    setInterval(async () => {
        console.log('6 saat doldu, tüm sunucularda seçme mesajları yenileniyor...');
        await refreshAllGuilds();
    }, SIX_HOURS);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const args = message.content.trim().split(/\s+/);
    const command = args[0].toLowerCase();

    if (!['!sendselect', '!sendclaimed'].includes(command)) return;

    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.delete().catch(() => {});
        return;
    }

    const guildId = message.guild.id;
    const config = guilds[guildId];

    if (!config) {
        console.warn(`[Sunucu: ${guildId}] guilds.json'da tanımlı değil, komut yoksayıldı.`);
        await message.delete().catch(() => {});
        return;
    }

    if (command === '!sendselect') {
        try {
            const ids = loadMessageIds();
            await deleteOldMessage(config.selection_channel_id, ids[guildId]);
            await sendSelectionMessage(guildId, config);
            await message.delete().catch(() => {});
        } catch (err) {
            console.error(`[Sunucu: ${guildId}] !sendselect hatası:`, err.message);
        }
    }

    if (command === '!sendclaimed') {
        const rewardType = (args[1] || 'robux').toLowerCase();
        const username = args.slice(2).join(' ') || 'username';

        try {
            const sourceMsg = rewardType === 'nitro' ? claimed2Msg : claimedMsg;
            let components = JSON.stringify(getComponents(sourceMsg));
            components = components.replace(/`username`/g, `\`${username}\``);
            components = JSON.parse(components);

            await sendComponentsV2(config.claimed_channel_id, components, config.claim_url);
            await message.delete().catch(() => {});
            console.log(`[Sunucu: ${guildId}] Claimed mesajı (${rewardType}) gönderildi.`);
        } catch (err) {
            console.error(`[Sunucu: ${guildId}] !sendclaimed hatası:`, err.message);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    if (interaction.customId === 'p_282739869845819396') {
        const guildId = interaction.guild?.id;
        const config = guilds[guildId];

        if (!config) {
            console.warn(`[Sunucu: ${guildId}] guilds.json'da tanımlı değil, interaction yoksayıldı.`);
            return;
        }

        try {
            const selectedValue = interaction.values[0];
            const username = interaction.user.username;

            const isNitro = selectedValue === '06BPLKq9Pr';
            const rewardType = isNitro ? 'nitro' : 'robux';

            const afterComponents = getComponents(afterSelectionMsg);

            await rest.post(Routes.interactionCallback(interaction.id, interaction.token), {
                body: {
                    type: 4,
                    data: {
                        flags: 64 | 32768,
                        components: cleanComponents(afterComponents, config.claim_url)
                    }
                }
            });

            const sourceMsg = isNitro ? claimed2Msg : claimedMsg;
            let claimedComponents = JSON.stringify(getComponents(sourceMsg));
            claimedComponents = claimedComponents.replace(/`username`/g, `\`${username}\``);
            claimedComponents = JSON.parse(claimedComponents);
            await sendComponentsV2(config.claimed_channel_id, claimedComponents, config.claim_url);

            console.log(`[Sunucu: ${guildId}] ${username} seçim yaptı (${rewardType}), fısıldama + claimed gönderildi.`);
        } catch (err) {
            console.error(`[Sunucu: ${guildId}] interaction hatası:`, err.message);
        }
    }
});

client.login(TOKEN);
