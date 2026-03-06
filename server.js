import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { google } from "googleapis";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SHEET_ID = process.env.SHEET_ID;
const TZ = { timeZone: "America/Argentina/Buenos_Aires" };

app.get("/", (req, res) => res.send("Bot de gastos activo ✅"));

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const { Body, MediaUrl0, MediaContentType0 } = req.body;
    const hoy = new Date().toLocaleDateString("es-AR", TZ);
    let gastoData;

    if (MediaUrl0) {
      const imageResponse = await fetch(MediaUrl0, {
        headers: {
          Authorization: "Basic " + Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString("base64"),
        },
      });
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString("base64");
      const mediaType = MediaContentType0 || "image/jpeg";

      const result = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${base64Image}` },
            },
            {
              type: "text",
              text: `Extraé del comprobante: monto (solo número), descripción breve, categoría (comida/transporte/servicios/salud/entretenimiento/ropa/supermercado/otro), fecha (formato DD/MM/AAAA, si no se ve usá ${hoy}).
Respondé SOLO JSON sin backticks: {"monto": 0, "descripcion": "", "categoria": "", "fecha": ""}`,
            },
          ],
        }],
      });

      gastoData = JSON.parse(result.choices[0].message.content.trim());

    } else if (Body) {
      const result = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `El usuario escribió: "${Body}"
Extraé: monto (solo número), descripción breve, categoría (comida/transporte/servicios/salud/entretenimiento/ropa/supermercado/otro), fecha (formato DD/MM/AAAA, si no se menciona usá ${hoy}).
Respondé SOLO JSON sin backticks: {"monto": 0, "descripcion": "", "categoria": "", "fecha": ""}`,
        }],
      });

      gastoData = JSON.parse(result.choices[0].message.content.trim());

    } else {
      twiml.message("Enviame un monto y descripción, por ejemplo: *350 almuerzo*");
      return res.type("text/xml").send(twiml.toString());
    }

    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Hoja1!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          gastoData.fecha,
          gastoData.descripcion,
          gastoData.categoria,
          gastoData.monto,
          new Date().toLocaleString("es-AR", TZ),
        ]],
      },
    });

    const emojis = { comida:"🍽️", transporte:"🚗", servicios:"💡", salud:"🏥", entretenimiento:"🎬", ropa:"👕", supermercado:"🛒", otro:"📌" };
    const cat = gastoData.categoria?.toLowerCase() || "otro";

    twiml.message(
      `✅ Gasto registrado!\n\n` +
      `💰 *$${gastoData.monto}*\n` +
      `📝 ${gastoData.descripcion}\n` +
      `${emojis[cat] || "📌"} ${gastoData.categoria}\n` +
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
