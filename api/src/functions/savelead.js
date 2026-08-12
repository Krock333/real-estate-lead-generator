const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

app.http("saveLead", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "saveLead",

  handler: async (request, context) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
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

      const firstName = String(body.firstName || "").trim();
      const lastName = String(body.lastName || "").trim();
      const email = String(body.email || "").trim();
      const phone = String(body.phone || "").trim();
      const interest = String(body.interest || "").trim();
      const timeline = String(body.timeline || "").trim();
      const goals = String(body.goals || "").trim();

      if (!firstName || !lastName || !email || !phone) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            success: false,
            message:
              "First name, last name, email, and phone number are required.",
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
        status: "New",
        assignedAgent: "Unassigned",
        submittedAt,
      };

      await tableClient.createEntity(leadEntity);

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