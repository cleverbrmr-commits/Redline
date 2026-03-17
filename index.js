require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  AttachmentBuilder,
} = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DATA_FILE = path.join(__dirname, "modules.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

async function ensureStorage() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  try { await fsp.access(DATA_FILE); }
  catch { await fsp.writeFile(DATA_FILE, "{}", "utf8"); }
}

async function loadModules() {
  const raw = await fsp.readFile(DATA_FILE, "utf8");
  return JSON.parse(raw || "{}");
}

async function saveModules(modules) {
  await fsp.writeFile(DATA_FILE, JSON.stringify(modules, null, 2), "utf8");
}

function slugify(input) {
  return input.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-");
}

async function downloadFile(url, destinationPath) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destinationPath, buffer);
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("mods")
      .setDescription("Open the mod panel"),

    new SlashCommandBuilder()
      .setName("upload")
      .setDescription("Upload a module")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

      .addStringOption(o =>
        o.setName("name")
         .setDescription("Module name")
         .setRequired(true)
      )

      .addAttachmentOption(o =>
        o.setName("file")
         .setDescription("File to upload")
         .setRequired(true)
      )

      .addStringOption(o =>
        o.setName("description")
         .setDescription("Optional description")
         .setRequired(false)
      )
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
}

client.once(Events.ClientReady, async () => {
  await ensureStorage();
  await registerCommands();
  console.log("Bot ready");
});

client.on(Events.InteractionCreate, async (i) => {
  if (i.isChatInputCommand()) {
    if (i.commandName === "mods") {
      const mods = await loadModules();
      const entries = Object.entries(mods);

      if (!entries.length) return i.reply({ content: "No modules yet", ephemeral: true });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("mod_select")
        .setPlaceholder("Choose...")
        .addOptions(entries.map(([k,v]) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(v.label)
            .setValue(k)
        ));

      const row = new ActionRowBuilder().addComponents(menu);

      return i.reply({
        embeds: [new EmbedBuilder().setTitle("Mod Hub").setDescription("Select a module")],
        components: [row]
      });
    }

    if (i.commandName === "upload") {
      const name = i.options.getString("name");
      const file = i.options.getAttachment("file");

      const key = slugify(name);
      const filePath = path.join(UPLOADS_DIR, key + ".bin");

      await downloadFile(file.url, filePath);

      const mods = await loadModules();
      mods[key] = { label: name, filePath };
      await saveModules(mods);

      return i.reply({ content: "Uploaded", ephemeral: true });
    }
  }

  if (i.isStringSelectMenu()) {
    const mods = await loadModules();
    const mod = mods[i.values[0]];
    const file = new AttachmentBuilder(mod.filePath);

    return i.reply({ files: [file], ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
