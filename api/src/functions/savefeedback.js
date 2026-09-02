const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const crypto = require("crypto");

const corsHeaders = {
  "Access-Control-Allow-Origin":
    process.env.HOME_READY_SITE_ORIGIN ||
    "https://orange-flower-00dbb1c10.7.azurestaticapps.net",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function clean(value, maxLength = 2000) {
  return String(value || "").trim().slice(0, maxLength);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return clean(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

async function sendEmail({ to, cc, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FEEDBACK_FROM_EMAIL;

  if (!apiKey || !from) {
    throw new Error("Email delivery is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
      reply_to: replyTo || undefined,
      subject,
      html
    })
  });

  if (!response.ok) {
    throw new Error(
      `Email provider returned ${response.status}: ${await response.text()}`
    );
  }
}

app.http("savefeedback", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",

  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: corsHeaders
      };
    }

    try {
      const body = await request.json();
      const feedbackType = clean(body.feedbackType, 20);
      const rating = clean(body.rating, 1);
      const comments = clean(body.comments, 4000);

      const name = clean(body.name, 120);
      const email = clean(body.email, 254).toLowerCase();
      const role = clean(body.role, 30);
      const recipient = clean(body.recipient, 30);
      const agent = clean(body.agent, 30);
      const contacted = clean(body.contacted, 30);

      if (
        !["consumer", "agent"].includes(feedbackType) ||
        !["1", "2", "3", "4", "5"].includes(rating) ||
        !comments
      ) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            message: "Required feedback fields are missing."
          }
        };
      }

      if (
        feedbackType === "consumer" &&
        (!name ||
          !isEmail(email) ||
          !["buyer", "seller"].includes(role) ||
          !["melissa", "home-ready"].includes(recipient))
      ) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            message: "Please complete all buyer or seller feedback fields."
          }
        };
      }

      if (
        feedbackType === "agent" &&
        (agent !== "melissa" || !["yes", "no"].includes(contacted))
      ) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            message: "Please complete all agent feedback fields."
          }
        };
      }

      const feedbackId = crypto.randomUUID();

      const entity = {
        partitionKey:
          feedbackType === "consumer"
            ? "ConsumerFeedback"
            : "AgentFeedback",
        rowKey: feedbackId,
        feedbackId,
        feedbackType,
        rating,
        comments,
        name,
        email,
        role,
        recipient,
        agent,
        contacted,
        createdAt: new Date().toISOString(),
        emailStatus: "pending"
      };

      const connectionString =
        process.env.AZURE_STORAGE_CONNECTION_STRING ||
        process.env.AzureWebJobsStorage;

      if (!connectionString) {
        throw new Error("Azure Storage is not configured.");
      }

      const table = TableClient.fromConnectionString(
        connectionString,
        "Feedback"
      );

      await table.createTable().catch(error => {
        if (error.statusCode !== 409) {
          throw error;
        }
      });

      await table.createEntity(entity);

      const adminEmail = process.env.HOME_READY_ADMIN_EMAIL;
      const melissaEmail = process.env.MELISSA_AGENT_EMAIL;
      let emailMessage;

      if (feedbackType === "consumer") {
        const isForMelissa = entity.recipient === "melissa";

        emailMessage = {
          to: isForMelissa ? melissaEmail : adminEmail,
          cc: isForMelissa ? adminEmail : undefined,
          replyTo: entity.email,
          subject:
            `${entity.role} feedback for ` +
            `${isForMelissa ? "Melissa LaChance" : "Home Ready"}`,
          html: `
            <h2>New Home Ready Feedback</h2>
            <p><strong>From:</strong>
              ${escapeHtml(entity.name)}
              (${escapeHtml(entity.email)})
            </p>
            <p><strong>Role:</strong>
              ${escapeHtml(entity.role)}
            </p>
            <p><strong>Rating:</strong>
              ${escapeHtml(entity.rating)} / 5
            </p>
            <p><strong>Comments:</strong></p>
            <p>${escapeHtml(entity.comments)}</p>
          `
        };
      } else {
        emailMessage = {
          to: adminEmail,
          subject: "Agent feedback from Melissa LaChance",
          html: `
            <h2>New Agent Feedback</h2>
            <p><strong>Agent:</strong> Melissa LaChance</p>
            <p><strong>Lead quality:</strong>
              ${escapeHtml(entity.rating)} / 5
            </p>
            <p><strong>Contacted lead:</strong>
              ${escapeHtml(entity.contacted)}
            </p>
            <p><strong>Comments:</strong></p>
            <p>${escapeHtml(entity.comments)}</p>
          `
        };
      }

      if (
        !emailMessage.to ||
        (entity.recipient === "melissa" && !melissaEmail)
      ) {
        throw new Error(
          "Feedback recipient email is not configured."
        );
      }

      let emailStatus = "sent";

      try {
        await sendEmail(emailMessage);
      } catch (emailError) {
        emailStatus = "failed";
        context.error("Feedback saved but email delivery failed", emailError);
      }

      await table.updateEntity({
        partitionKey: entity.partitionKey,
        rowKey: entity.rowKey,
        emailStatus
      }, "Merge");

      return {
        status: emailStatus === "sent" ? 201 : 202,
        headers: corsHeaders,
        jsonBody: {
          success: true,
          message: emailStatus === "sent"
            ? "Feedback saved and emailed successfully."
            : "Feedback was saved. Email delivery is pending.",
          feedbackId,
          emailStatus
        }
      };
    } catch (error) {
      context.error("Feedback submission failed", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          message: "Feedback could not be processed."
        }
      };
    }
  }
});