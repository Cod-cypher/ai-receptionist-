/**
 * Seeds a demo towing company so the pipeline can be exercised immediately.
 *
 * Creates two businesses on purpose: the second one exists so tenant isolation
 * is something you can check by hand, not just in a test.
 */

import './load-env';
import { Client } from 'pg';
import * as argon2 from 'argon2';

const DEMO_SERVICES = [
  'Local towing',
  'Long-distance towing',
  'Flatbed towing',
  'Motorcycle towing',
  'Roadside assistance',
  'Jump starts',
  'Tire changes',
  'Fuel delivery',
  'Lockouts',
];

async function seed(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_MIGRATION_URL or DATABASE_URL');

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const passwordHash = await argon2.hash('demo-password-1234', { type: argon2.argon2id });

    const businesses = [
      {
        name: 'Liberty Towing',
        email: 'owner@libertytowing.test',
        number: '+924235000001',
        whatsapp: '+923001234567',
        areas: ['Lahore', 'Gulberg', 'DHA', 'Model Town', 'Johar Town'],
        greeting: 'Thanks for calling Liberty Towing. How can I help?',
      },
      {
        name: 'Rapid Recovery',
        email: 'owner@rapidrecovery.test',
        number: '+924235000002',
        whatsapp: '+923009998888',
        areas: ['Karachi', 'Clifton', 'DHA Karachi'],
        greeting: 'Rapid Recovery, how can I help you?',
      },
    ];

    for (const b of businesses) {
      // Safe to re-run: a tester resetting their data should not have to know
      // which rows already exist.
      const existing = await client.query<{ business_id: string }>(
        'SELECT business_id FROM phone_numbers WHERE e164 = $1',
        [b.number],
      );
      if (existing.rows[0]) {
        process.stdout.write(
          `exists  ${b.name}  id=${existing.rows[0].business_id}  number=${b.number}
`,
        );
        continue;
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO businesses
           (name, phone, timezone, service_areas, business_hours, pricing_info,
            emergency_contact, whatsapp_number, default_region_prefix)
         VALUES ($1, $2, 'Asia/Karachi', $3::jsonb, $4::jsonb, $5, $6, $7, '+92')
         RETURNING id`,
        [
          b.name,
          b.number,
          JSON.stringify(b.areas),
          JSON.stringify(
            // Towing is a 24/7 business; this is what makes "are you open?"
            // answerable from configuration rather than guessed at.
            Array.from({ length: 7 }, (_, day) => ({
              day,
              open: '00:00',
              close: '23:59',
              closed: false,
            })),
          ),
          'Local tows start at PKR 3,500. Long distance is quoted per kilometre.',
          '+923001112222',
          b.whatsapp,
        ],
      );

      const businessId = rows[0]!.id;
      await client.query(`SELECT set_config('app.business_id', $1, false)`, [businessId]);

      await client.query(
        `INSERT INTO users (business_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner')`,
        [businessId, b.email, passwordHash, 'Demo Owner'],
      );

      await client.query(
        `INSERT INTO business_settings (business_id, greeting, tone, faq)
         VALUES ($1, $2, 'friendly', $3::jsonb)`,
        [
          businessId,
          b.greeting,
          JSON.stringify([
            {
              question: 'Do you tow motorcycles?',
              answer: 'Yes, we tow motorcycles using a flatbed.',
            },
            {
              question: 'Do you do long distance towing?',
              answer: 'Yes, we handle long-distance towing across the province.',
            },
          ]),
        ],
      );

      for (const [index, name] of DEMO_SERVICES.entries()) {
        await client.query(
          `INSERT INTO services (business_id, name, sort_order) VALUES ($1, $2, $3)`,
          [businessId, name, index],
        );
      }

      await client.query(
        `INSERT INTO phone_numbers (business_id, e164) VALUES ($1, $2)`,
        [businessId, b.number],
      );

      process.stdout.write(`seeded ${b.name}  id=${businessId}  number=${b.number}\n`);
    }

    process.stdout.write('\nlogin with: owner@libertytowing.test / demo-password-1234\n');
  } finally {
    await client.end();
  }
}

seed().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
