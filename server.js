import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { google } from "googleapis";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets auth usando la variable de entorno GOOGLE_CREDENTIALS
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SHEET_ID = process.env.SHEET_ID;

// Health check
app.get("/", (req, res) => res.send("Bot de gastos activo ✅"));

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const { Body, MediaUrl0, MediaContentType0 } = req.body;

    let gastoData;

    if (MediaUrl0) {
      // Viene una imagen (comprobante/ticket)
      const imageResponse = await fetch(MediaUrl0, {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString("base64"),
        },
      });

      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString("base64");
      const mediaType = MediaContentType0 || "image/jpeg";

      const result = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64Image },
              },
              {
                type: "text",
                text: `Sos un asistente que extrae datos de comprobantes de gastos.
Analizá la imagen y extraé: monto (solo el número, sin símbolos), descripción breve, categoría (elegí una: comida, transporte, servicios, salud, entretenimiento, ropa, supermercado, otro), fecha (formato DD/MM/YYYY, si no se ve usá hoy: ${new Date().toLocaleDateString("es-AR")}).
Respondé SOLO con JSON válido, sin texto extra, sin backticks:
{"monto": 0, "descripcion": "", "categoria": "", "fecha": ""}`,
              },
            ],
          },
        ],
      });

      const text = result.content[0].text.trim();
      gastoData = JSON.parse(text);
    } else if (Body) {
      // Viene texto
      const result = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `Sos un asistente que extrae datos de gastos desde mensajes de texto.
El usuario escribió: "${Body}"
Extraé: monto (solo número, sin símbolos de moneda), descripción breve, categoría (elegí una: comida, transporte, servicios, salud, entretenimiento, ropa, supermercado, otro), fecha (formato DD/MM/YYYY, si no se menciona usá hoy: ${new Date().toLocaleDateString("es-AR")}).
Respondé SOLO con JSON válido, sin texto extra, sin backticks:
{"monto": 0, "descripcion": "", "categoria": "", "fecha": ""}`,
          },
        ],
      });

      const text = result.content[0].text.trim();
      gastoData = JSON.parse(text);
    } else {
      twiml.message("No entendí el mensaje. Enviame un monto y descripción, por ejemplo: *350 almuerzo*");
      return res.type("text/xml").send(twiml.toString());
    }

    // Guardar en Google Sheets
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Hoja1!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            gastoData.fecha,
            gastoData.descripcion,
            gastoData.categoria,
            gastoData.monto,
            new Date().toLocaleString("es-AR"),
          ],
        ],
      },
    });

    // Respuesta al usuario
    const emoji = {
      comida: "🍽️", transporte: "🚗", servicios: "💡",
      salud: "🏥", entretenimiento: "🎬", ropa: "👕",
      supermercado: "🛒", otro: "📌",
    };
    const cat = gastoData.categoria?.toLowerCase() || "otro";

    twiml.message(
      `✅ Gasto registrado!\n\n` +
      `💰 *$${gastoData.monto}*\n` +
      `📝 ${gastoData.descripcion}\n` +
      `${emoji[cat] || "📌"} ${gastoData.categoria}\n` +
      `📅 ${gastoData.fecha}`
    );
  } catch (err) {
    console.error("Error:", err);
    twiml.message("❌ Hubo un error al registrar el gasto. Intentá de nuevo.");
  }

  res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
