// Serviciu MedGemma FALS, doar pentru teste locale, până când echipa AI
// face serviciul real. Respectă contractul din src/medgemma.ts:
//   POST /extract, body = octeții fișierului -> 200 + { "extracted_data": {...} }
// Nu citește documentul: întoarce mereu aceleași date sintetice.
//
// Pornire (din folderul Backend):  npx tsx scripts/mock-medgemma.ts
// Apoi în Backend/.env:            MEDGEMMA_URL=http://127.0.0.1:8090
import express from 'express';

const app = express();
const port = Number(process.env.MOCK_MEDGEMMA_PORT ?? 8090);

app.post('/extract', express.raw({ type: () => true, limit: '20mb' }), (request, response) => {
  const receivedBytes = Buffer.isBuffer(request.body) ? request.body.length : 0;
  console.log(`[mock-medgemma] am primit ${receivedBytes} octeți (${request.headers['content-type']})`);

  response.json({
    extracted_data: {
      source: 'mock-medgemma',
      document_kind: 'lab_result',
      values: [
        { name: 'Hemoglobină', value: 13.5, unit: 'g/dL' },
        { name: 'Glicemie', value: 92, unit: 'mg/dL' },
      ],
      note: 'Date sintetice generate de mock, nu de MedGemma.',
    },
  });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Mock MedGemma: http://127.0.0.1:${port}/extract`);
});
