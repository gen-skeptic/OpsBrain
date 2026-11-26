-- OpsBrain 003: update_record used to store a record's `fields` as a JSON string instead of an object
-- (fixed in server/records.ts). Turn those values back into objects. Rows that are already objects are untouched.
UPDATE thoughts SET fields = (fields #>> '{}')::jsonb
 WHERE jsonb_typeof(fields) = 'string' AND left(fields #>> '{}', 1) = '{';
