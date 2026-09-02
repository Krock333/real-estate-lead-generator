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
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalize(value, maxLength = 100) {
  return clean(value, maxLength).toLowerCase();
}

function normalizeRecipient(value) {
  const recipient = normalize(value)
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

  if (recipient === "melissa-lachance") {
    return "melissa";
  }

  if (recipient === "homeready") {
    return "home-ready";
  }

  return recipient;
}

function normalizeAgent(value) {
  const agent = normalize(value)
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");

  if (agent === "melissa-lachance") {
    return "melissa";
  }

  return agent;
}

function normalizeRating(value) {
  const match = clean(value, 30).match(/[1-5]/);
  return match ? match[0] : "";
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
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

  if (!to) {
    throw new Error("The recipient email is not configured.");
  }

  const emailBody = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  };

  if (cc) {
    emailBody.cc = Array.isArray(cc) ? cc : [cc];
  }

  if (replyTo) {
    emailBody.reply_to = replyTo;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(emailBody)
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Email provider returned ${response.status}: ${errorText}`
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
      let body;

      try {
        body = await request.json();
      } catch {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            success: false,
            message: "The feedback request must contain valid information."
          }
        };
      }

      const feedbackType = normalize(body.feedbackType, 20);
      const rating = normalizeRating(body.rating);
      const comments = clean(body.comments, 4000);

      const name = clean(body.name, 120);
      const email = normalize(body.email, 254);
      const role = normalize(body.role, 30);
      const recipient = normalizeRecipient(body.recipient);

      const agent = normalizeAgent(body.agent);
      const contacted = normalize(body.contacted, 30);

      if (!["consumer", "agent"].includes(feedbackType)) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            success: false,
            message: "Please select a valid feedback form."
          }
        };
      }

      if (!rating) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            success: false,
            message: "Please select a rating from 1 through 5."
          }
        };
      }

      if (!comments) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            success: false,
            message: "Please enter your comments or suggestions."
          }
        };
      }

      if (feedbackType === "consumer") {
        if (!name) {
          return {
            status: 400,
            headers: corsHeaders,
            jsonBody: {
              success: false,
              message: "Please enter your name."
            }
          };
        }

        if (!isEmail(email)) {
          return {
            status: 400,
            headers: corsHeaders,
            jsonBody: {
              success: false,
              message: "Please enter a valid email address."
            }
          };
        }

        if (!["buyer", "seller"].includes(role)) {
          return {
            status: 400,
            headers: corsHeaders,
            jsonBody: {
              success: false,
              message: "Please select Buyer or Seller."
            }
          };
        }

        if (!["melissa", "home-ready"].includes(recipient)) {
          return {
            status: 400,
            headers: corsHeaders,
            jsonBody: {
              success: false,
              message: "Please select who should receive your feedback."
            }
          };
        }
      }

      if (feedbackType === "agent") {
        if (agent !== "melissa") {
          return {
            status: 400,
            headers: corsHeaders,
            jsonBody: {
              success: false,
              message: "Please select Melissa LaChance as the agent."
            }
          };
        }

        if (!["yes", "no"].includes(contacted)) {
          return {
            status: 400,
            headers: corsHeaders,
            jsonBody: {
              success: false,
              message: "Please indicate whether the lead was contacted."
            }
          };
        }
      }

      const connectionString =
        process.env.AZURE_STORAGE_CONNECTION_STRING ||
        process.env.AzureWebJobsStorage;

      if (!connectionString) {
        throw new Error("Azure Storage is not configured.");
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

      const table = TableClient.fromConnectionString(
        connectionString,
        "Feedback"
      );

      try {
        await table.createTable();
      } catch (error) {
        if (error.statusCode !== 409) {
          throw error;
        }
      }

      await table.createEntity(entity);

      const adminEmail = clean(
        process.env.HOME_READY_ADMIN_EMAIL,
        254
      );

      const melissaEmail = clean(
        process.env.MELISSA_AGENT_EMAIL,
        254
      );

      let emailMessage;

      if (feedbackType === "consumer") {
        const isForMelissa = recipient === "melissa";

        if (!adminEmail) {
          throw new Error(
            "The Home Ready administrator email is not configured."
          );
        }

        if (isForMelissa && !melissaEmail) {
          throw new Error(
            "Melissa's agent email is not configured."
          );
        }

        emailMessage = {
          to: isForMelissa ? melissaEmail : adminEmail,
          cc: isForMelissa ? adminEmail : undefined,
          replyTo: email,
          subject:
            `${role === "buyer" ? "Buyer" : "Seller"} feedback for ` +
            `${isForMelissa ? "Melissa LaChance" : "Home Ready"}`,
          html: `
            <h2>New Home Ready Feedback</h2>
            <p>
              <strong>From:</strong>
              ${escapeHtml(name)} (${escapeHtml(email)})
            </p>
            <p>
              <strong>Role:</strong>
              ${escapeHtml(role === "buyer" ? "Buyer" : "Seller")}
            </p>
            <p>
              <strong>Recipient:</strong>
              ${escapeHtml(
                isForMelissa ? "Melissa LaChance" : "Home Ready"
              )}
            </p>
            <p>
              <strong>Rating:</strong>
              ${escapeHtml(rating)} / 5
            </p>
            <p><strong>Comments:</strong></p>
            <p>${escapeHtml(comments)}</p>
          `
        };
      } else {
        if (!adminEmail) {
          throw new Error(
            "The Home Ready administrator email is not configured."
          );
        }

        emailMessage = {
          to: adminEmail,
          subject: "Agent feedback from Melissa LaChance",
          html: `
            <h2>New Agent Feedback</h2>
            <p><strong>Agent:</strong> Melissa LaChance</p>
            <p>
              <strong>Lead quality:</strong>
              ${escapeHtml(rating)} / 5
            </p>
            <p>
              <strong>Contacted lead:</strong>
              ${escapeHtml(contacted === "yes" ? "Yes" : "No")}
            </p>
            <p><strong>Comments:</strong></p>
            <p>${escapeHtml(comments)}</p>
          `
        };
      }

      let emailStatus = "sent";

      try {
        await sendEmail(emailMessage);
      } catch (emailError) {
        emailStatus = "failed";

        context.error(
          "Feedback saved but email delivery failed",
          emailError
        );
      }

      await table.updateEntity(
        {
          partitionKey: entity.partitionKey,
          rowKey: entity.rowKey,
          emailStatus
        },
        "Merge"
      );

      return {
        status: emailStatus === "sent" ? 201 : 202,
        headers: corsHeaders,
        jsonBody: {
          success: true,
          message:
            emailStatus === "sent"
              ? "Thank you! Your feedback was saved and emailed."
              : "Thank you! Your feedback was saved, but the email is pending.",
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
          success: false,
          message:
            "We could not process your feedback. Please try again."
        }
      };
    }
  }
});