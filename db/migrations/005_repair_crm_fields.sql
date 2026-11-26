-- OpsBrain 005: CRM updates used to store `fields` on companies, contacts and deals as a JSON string instead of an
-- object (fixed in server/crm.ts). Turn those values back into objects. Rows that are already objects are untouched.
UPDATE crm_companies SET fields = (fields #>> '{}')::jsonb
 WHERE jsonb_typeof(fields) = 'string' AND left(fields #>> '{}', 1) = '{';
UPDATE crm_contacts SET fields = (fields #>> '{}')::jsonb
 WHERE jsonb_typeof(fields) = 'string' AND left(fields #>> '{}', 1) = '{';
UPDATE crm_deals SET fields = (fields #>> '{}')::jsonb
 WHERE jsonb_typeof(fields) = 'string' AND left(fields #>> '{}', 1) = '{';
