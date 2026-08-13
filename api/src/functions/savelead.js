


const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const allowedOrigin =
  process.env.HOME_READY_SITE_ORIGIN ||
  "https://orange-flower-00dbb1c10.7.azurestaticapps.net";

function clean(value, maxLength = 2000) {
  return String(value || "").trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return clean(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

async function sendLeadEmail(lead) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LEAD_FROM_EMAIL || process.env.FEEDBACK_FROM_EMAIL;
  const agentEmail = process.env.MELISSA_AGENT_EMAIL;
  const adminEmail = process.env.HOME_READY_ADMIN_EMAIL;

  if (!apiKey || !from || !agentEmail || !adminEmail) {
    throw new Error("Lead email delivery is not configured.");
  }

  const readiness = lead.readinessScore
    ? `${escapeHtml(lead.readinessScore)}% ${escapeHtml(lead.assessmentType)} readiness`
    : "No readiness assessment completed";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [agentEmail],
      cc: [adminEmail],
      reply_to: lead.email,
      subject: `New Home Ready ${lead.interest || "real estate"} lead: ${lead.firstName} ${lead.lastName}`,
      html: `<h2>New Home Ready Lead</h2>
        <p><strong>Name:</strong> ${escapeHtml(lead.firstName)} ${escapeHtml(lead.lastName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(lead.phone)}</p>
        <p><strong>Interest:</strong> ${escapeHtml(lead.interest || "Not provided")}</p>
        <p><strong>Timeline:</strong> ${escapeHtml(lead.timeline || "Not provided")}</p>
        <p><strong>Readiness:</strong> ${readiness}</p>
        <p><strong>Goals:</strong></p><p>${escapeHtml(lead.goals || "Not provided")}</p>
        <p><small>Lead ID: ${escapeHtml(lead.leadId)}</small></p>`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Email provider returned ${response.status}: ${await response.text()}`);
  }
}

app.http("saveLead", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "saveLead",

  handler: async (request, context) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Allow browser CORS preflight requests.
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: corsHeaders,
      };
    }

    try {
      const body = await request.json();

      const firstName = clean(body.firstName, 80);
      const lastName = clean(body.lastName, 80);
      const email = clean(body.email, 254);
      const phone = clean(body.phone, 40);
      const interest = clean(body.interest, 80);
      const timeline = clean(body.timeline, 80);
      const goals = clean(body.goals, 4000);
      const assessmentType = clean(body.assessmentType, 20);
      const readinessScore = clean(body.readinessScore, 3);

      if (!firstName || !lastName || !email || !phone || !interest || !timeline) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            success: false,
            message:
              "First name, last name, email, phone number, interest, and timeline are required.",
          },
        };
      }

      const connectionString =
        process.env.AzureWebJobsStorage || "UseDevelopmentStorage=true";

      const tableClient = TableClient.fromConnectionString(
        connectionString,
        "Leads"
      );

      await tableClient.createTable().catch((error) => {
        // Error code 409 means the table already exists.
        if (error.statusCode !== 409) {
          throw error;
        }
      });

      const leadId = randomUUID();
      const submittedAt = new Date().toISOString();

      const leadEntity = {
        partitionKey: "HomeReadyLead",
        rowKey: leadId,
        leadId,
        firstName,
        lastName,
        email,
        phone,
        interest,
        timeline,
        goals,
        assessmentType,
        readinessScore,
        status: "New",
        assignedAgent: "Melissa LaChance",
        notificationStatus: "pending",
        submittedAt,
      };

      await tableClient.createEntity(leadEntity);

      try {
        await sendLeadEmail(leadEntity);
        await tableClient.updateEntity({
          partitionKey: leadEntity.partitionKey,
          rowKey: leadEntity.rowKey,
          notificationStatus: "sent",
        }, "Merge");
      } catch (emailError) {
        context.error("Lead saved but notification email failed:", emailError);
        await tableClient.updateEntity({
          partitionKey: leadEntity.partitionKey,
          rowKey: leadEntity.rowKey,
          notificationStatus: "failed",
        }, "Merge");
      }

      context.log("Lead saved successfully:", {
        leadId,
        firstName,
        lastName,
        email,
        phone,
        interest,
        timeline,
        submittedAt,
      });

      return {
        status: 201,
        headers: corsHeaders,
        jsonBody: {
          success: true,
          message: "Your consultation request was saved successfully.",
          leadId,
        },
      };
    } catch (error) {
      context.error("Unable to save lead:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          success: false,
          message: "The lead could not be saved. Please try again.",
        },
      };
    }
  },
});