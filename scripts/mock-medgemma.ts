// Serviciu de extragere FALS, doar pentru teste locale, când serviciul real
// (AI/edge/extraction_service) nu rulează. Respectă contractul din src/medgemma.ts
// și din AI/edge/extraction_service/schemas.py:
//   POST /extract, body = octeții fișierului -> 200 + { "extracted_data": {...} }
// Nu citește documentul: întoarce mereu aceeași rețetă sintetică (date fictive).
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
      medications: [
        { name: 'Amlodipină', dose: '5 mg', frequency: '1 comprimat dimineața', duration: '30 de zile' },
        { name: 'Metformin', dose: null, frequency: '2 comprimate pe zi', duration: null },
      ],
      diagnoses: [],
      lab_results: [],
      dates: [{ label: 'Data', value: '14.03.2025' }],
      warnings: ['Date sintetice generate de mock, nu de serviciul real. Doza pentru Metformin este lăsată ilizibilă intenționat.'],
      source: { model: 'mock-medgemma', input_kind: 'image', pages: 1 },
    },
  });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Mock extragere: http://127.0.0.1:${port}/extract`);
});
