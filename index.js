require("dotenv").config();

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
  MessageFlags,
} = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DATA_FILE = path.join(__dirname, "modules.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PANEL_TITLE = "Client Browser";

async function ensureStorage() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch {
    await fsp.writeFile(DATA_FILE, "{}", "utf8");
  }
}

async function loadModules() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function saveModules(modules) {
  await fsp.writeFile(DATA_FILE, JSON.stringify(modules, null, 2), "utf8");
}

function slugify(input) {
  return input.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeCategory(input) {
  if (!input) return "General";
  return input.trim().slice(0, 80) || "General";
}

function extensionFromAttachmentName(name) {
  const ext = path.extname(name || "").toLowerCase();
  return ext && ext.length <= 10 ? ext : ".dat";
}

async function downloadFile(url, destinationPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destinationPath, buffer);
}

async function safeFetchGuild(guildId) {
  if (!guildId) return null;
  return client.guilds.fetch(guildId).catch(() => null);
}

async function safeFetchMember(guild, userId) {
  if (!guild || !userId) return null;
  return guild.members.fetch(userId).catch(() => null);
}

async function safeFetchChannel(channelId) {
  if (!channelId) return null;
  return client.channels.fetch(channelId).catch(() => null);
}

function isVisibleToMember(clientMeta, member) {
  if (!clientMeta) return false;
  if (!member) return clientMeta.visibility !== "role";
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

  if (clientMeta.visibility === "role") {
    return !!(clientMeta.roleId && member.roles?.cache?.has(clientMeta.roleId));
  }

  if (clientMeta.roleId) {
    return member.roles?.cache?.has(clientMeta.roleId);
  }

  return true;
}

function visibleClients(modules, member) {
  return Object.entries(modules)
    .filter(([, meta]) => isVisibleToMember(meta, member))
    .sort((a, b) => (a[1].name || a[1].label || a[0]).localeCompare(b[1].name || b[1].label || b[0]));
}

function categoriesFromClients(entries) {
  const set = new Set(["all"]);
  for (const [, meta] of entries) {
    set.add((meta.category || "General").trim() || "General");
  }
  return [...set];
}

function categoryMenuOptions(categories, selectedCategory) {
  return categories.slice(0, 25).map((cat) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(cat === "all" ? "All Categories" : cat)
      .setValue(cat)
      .setDefault(cat === selectedCategory)
  );
}

function clientMenuOptions(entries) {
  return entries.slice(0, 25).map(([key, meta]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel((meta.name || meta.label || key).slice(0, 100))
      .setDescription((meta.description || "No description provided").slice(0, 100))
      .setValue(key)
  );
}

function buildBrowserEmbed(filteredEntries, selectedCategory) {
  const lines = filteredEntries
    .slice(0, 12)
    .map(([, meta], idx) => `**${idx + 1}.** ${meta.name || meta.label} · \`${meta.category || "General"}\``)
    .join("\n");

  return new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setColor(0x5865f2)
    .setDescription([
      `Browse and download available clients safely.`,
      `**Category:** ${selectedCategory === "all" ? "All Categories" : selectedCategory}`,
      "",
      lines || "No clients available in this category.",
    ].join("\n"))
    .setFooter({ text: `Showing ${filteredEntries.length} client(s)` })
    .setTimestamp();
}

function buildBrowserComponents(entries, selectedCategory, scope) {
  const categories = categoriesFromClients(entries);
  const filtered = selectedCategory === "all"
    ? entries
    : entries.filter(([, meta]) => (meta.category || "General") === selectedCategory);

  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(`clients_category:${scope}`)
    .setPlaceholder("Choose category")
    .addOptions(categoryMenuOptions(categories, selectedCategory));

  const rows = [new ActionRowBuilder().addComponents(categoryMenu)];

  if (filtered.length) {
    const clientMenu = new StringSelectMenuBuilder()
      .setCustomId(`clients_client:${scope}`)
      .setPlaceholder("Select a client to download")
      .addOptions(clientMenuOptions(filtered));

    rows.push(new ActionRowBuilder().addComponents(clientMenu));
  }

  return { rows, filtered };
}

function parseCustomId(customId) {
  const [kind, scope] = (customId || "").split(":");
  return { kind, scope };
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("mods")
      .setDescription("Open your private client browser"),

    new SlashCommandBuilder()
      .setName("clients")
      .setDescription("Open your private client browser"),

    new SlashCommandBuilder()
      .setName("clientpanel")
      .setDescription("Manage the public client panel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s
        .setName("send")
        .setDescription("Post the public client panel in this channel")),

    new SlashCommandBuilder()
      .setName("upload")
      .setDescription("Upload a new client")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName("name").setDescription("Client name").setRequired(true))
      .addAttachmentOption((o) => o.setName("file").setDescription("Client file").setRequired(true))
      .addStringOption((o) => o.setName("description").setDescription("Description").setRequired(false))
      .addStringOption((o) => o.setName("category").setDescription("Category").setRequired(false))
      .addRoleOption((o) => o.setName("role").setDescription("Role required to view").setRequired(false))
      .addBooleanOption((o) => o.setName("role_only").setDescription("Only role members can view").setRequired(false)),

    new SlashCommandBuilder()
      .setName("editclient")
      .setDescription("Edit existing client metadata")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName("key").setDescription("Client key/slug").setRequired(true))
      .addStringOption((o) => o.setName("name").setDescription("New display name").setRequired(false))
      .addStringOption((o) => o.setName("description").setDescription("New description").setRequired(false))
      .addStringOption((o) => o.setName("category").setDescription("New category").setRequired(false))
      .addRoleOption((o) => o.setName("role").setDescription("Role required to view").setRequired(false))
      .addBooleanOption((o) => o.setName("role_only").setDescription("Only role members can view").setRequired(false))
      .addAttachmentOption((o) => o.setName("file").setDescription("Replace client file").setRequired(false)),

    new SlashCommandBuilder()
      .setName("removeclient")
      .setDescription("Remove a client")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName("key").setDescription("Client key/slug").setRequired(true)),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
}

async function sendPrivateBrowser(interaction, selectedCategory = "all") {
  const modules = await loadModules();
  const guild = await safeFetchGuild(interaction.guildId);
  const member = interaction.member ?? await safeFetchMember(guild, interaction.user.id);
  const entries = visibleClients(modules, member);
  const { rows, filtered } = buildBrowserComponents(entries, selectedCategory, "private");

  return interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [buildBrowserEmbed(filtered, selectedCategory)],
    components: rows,
  });
}

async function sendPublicPanel(interaction) {
  if (!interaction.guildId || !interaction.channelId) {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: "This command can only be used in a server channel." });
  }

  const channel = await safeFetchChannel(interaction.channelId);
  if (!channel || typeof channel.send !== "function") {
    return interaction.reply({ flags: MessageFlags.Ephemeral, content: "I couldn't post in this channel." });
  }

  const modules = await loadModules();
  const guild = await safeFetchGuild(interaction.guildId);
  const member = interaction.member ?? await safeFetchMember(guild, interaction.user.id);
  const entries = visibleClients(modules, member);
  const { rows, filtered } = buildBrowserComponents(entries, "all", "public");
  const baseEmbed = buildBrowserEmbed(filtered, "all");
  const publicEmbed = EmbedBuilder.from(baseEmbed).setDescription([
    "Use the menus below to browse clients.",
    "Downloads are always delivered privately.",
    "",
    baseEmbed.data.description || "",
  ].join("\n"));

  await channel.send({
    embeds: [publicEmbed],
    components: rows,
  });

  return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Public client panel sent." });
}

client.once(Events.ClientReady, async () => {
  await ensureStorage();
  await registerCommands();
  console.log(`Bot ready as ${client.user?.tag || "unknown"}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "clients" || interaction.commandName === "mods") {
        return sendPrivateBrowser(interaction);
      }

      if (interaction.commandName === "clientpanel" && interaction.options.getSubcommand() === "send") {
        return sendPublicPanel(interaction);
      }

      if (interaction.commandName === "upload") {
        const name = interaction.options.getString("name", true).trim();
        const key = slugify(name);
        const file = interaction.options.getAttachment("file", true);
        const description = interaction.options.getString("description") || "No description provided";
        const category = sanitizeCategory(interaction.options.getString("category"));
        const role = interaction.options.getRole("role");
        const roleOnly = interaction.options.getBoolean("role_only") ?? false;

        if (!file.url) {
          return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Invalid file attachment." });
        }

        await ensureStorage();
        const ext = extensionFromAttachmentName(file.name);
        const destination = path.join(UPLOADS_DIR, `${key}${ext}`);
        await downloadFile(file.url, destination);

        const modules = await loadModules();
        modules[key] = {
          key,
          name,
          label: name,
          description,
          category,
          roleId: role?.id || null,
          visibility: roleOnly ? "role" : "public",
          filePath: destination,
          fileName: file.name || path.basename(destination),
          uploadedBy: interaction.user.id,
          updatedAt: new Date().toISOString(),
        };
        await saveModules(modules);

        return interaction.reply({ flags: MessageFlags.Ephemeral, content: `Uploaded client \`${name}\` (${key}).` });
      }

      if (interaction.commandName === "editclient") {
        const key = slugify(interaction.options.getString("key", true));
        const modules = await loadModules();
        const existing = modules[key];

        if (!existing) {
          return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Client not found." });
        }

        const nextName = interaction.options.getString("name")?.trim();
        const nextDescription = interaction.options.getString("description");
        const nextCategory = interaction.options.getString("category");
        const nextRole = interaction.options.getRole("role");
        const nextRoleOnly = interaction.options.getBoolean("role_only");
        const replacementFile = interaction.options.getAttachment("file");

        if (nextName) {
          existing.name = nextName;
          existing.label = nextName;
        }
        if (nextDescription !== null) existing.description = nextDescription;
        if (nextCategory !== null) existing.category = sanitizeCategory(nextCategory);
        if (nextRole) existing.roleId = nextRole.id;
        if (nextRoleOnly !== null) existing.visibility = nextRoleOnly ? "role" : "public";

        if (replacementFile?.url) {
          const ext = extensionFromAttachmentName(replacementFile.name);
          const destination = path.join(UPLOADS_DIR, `${key}${ext}`);
          await downloadFile(replacementFile.url, destination);
          existing.filePath = destination;
          existing.fileName = replacementFile.name || path.basename(destination);
        }

        existing.updatedAt = new Date().toISOString();
        modules[key] = existing;
        await saveModules(modules);

        return interaction.reply({ flags: MessageFlags.Ephemeral, content: `Updated client \`${key}\`.` });
      }

      if (interaction.commandName === "removeclient") {
        const key = slugify(interaction.options.getString("key", true));
        const modules = await loadModules();
        const existing = modules[key];

        if (!existing) {
          return interaction.reply({ flags: MessageFlags.Ephemeral, content: "Client not found." });
        }

        delete modules[key];
        await saveModules(modules);

        if (existing.filePath) {
          await fsp.unlink(existing.filePath).catch(() => {});
        }

        return interaction.reply({ flags: MessageFlags.Ephemeral, content: `Removed client \`${key}\`.` });
      }
    }

    if (interaction.isStringSelectMenu()) {
      const { kind, scope } = parseCustomId(interaction.customId);
      if (!["clients_category", "clients_client"].includes(kind)) return;

      const modules = await loadModules();
      const guild = await safeFetchGuild(interaction.guildId);
      const member = interaction.member ?? await safeFetchMember(guild, interaction.user.id);
      const entries = visibleClients(modules, member);

      if (kind === "clients_category") {
        const selectedCategory = interaction.values[0] || "all";
        const { rows, filtered } = buildBrowserComponents(entries, selectedCategory, scope || "private");
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [buildBrowserEmbed(filtered, selectedCategory)],
          components: rows,
        });
      }

      const key = interaction.values[0];
      const clientMeta = modules[key];
      if (!clientMeta || !isVisibleToMember(clientMeta, member)) {
        return interaction.reply({ flags: MessageFlags.Ephemeral, content: "That client is unavailable to you." });
      }

      try {
        await fsp.access(clientMeta.filePath);
      } catch {
        return interaction.reply({ flags: MessageFlags.Ephemeral, content: "That client file is missing." });
      }

      const file = new AttachmentBuilder(clientMeta.filePath, { name: clientMeta.fileName || path.basename(clientMeta.filePath) });
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(clientMeta.name || clientMeta.label || key)
        .setDescription(clientMeta.description || "No description provided")
        .addFields(
          { name: "Category", value: clientMeta.category || "General", inline: true },
          { name: "Visibility", value: clientMeta.visibility === "role" ? "Role-gated" : "Public", inline: true }
        )
        .setTimestamp();

      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [embed],
        files: [file],
      });
    }
  } catch (error) {
    console.error("Interaction error:", error);
    const payload = { flags: MessageFlags.Ephemeral, content: "Something went wrong while handling that interaction." };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
