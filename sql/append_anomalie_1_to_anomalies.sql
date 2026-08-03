-- Append p_11_26_5151_koeln_deutzerfeld.anomalie_1 into public.anomalies,
-- plus the public.projects row the FK requires. Single transaction, all-or-nothing.
--
-- ============================ ID RULE (PROVEN) ============================
-- public.anomalies.id = uuid5(NAMESPACE_DNS, target_id)
--   namespace : 6ba7b810-9dad-11d1-80b4-00c04fd430c8  (uuid.NAMESPACE_DNS)
--   input     : the target_id string, and nothing else
--
-- Sources in the codebase, all identical:
--   ingest_anomalies.py:121, server.py:290 (import_points),
--   server.py:602 (seed), server.py:622-625 (hardcoded seed ids)
-- models.py:22 also declares default=uuid4(), but no anomaly insert path ever
-- reaches it - every one passes an explicit uuid5. It is a red herring.
--
-- Verified before writing this file: recomputing uuid5(NAMESPACE_DNS, target_id)
-- for ALL 1583 pre-existing public.anomalies rows reproduced the stored id with
-- 0 mismatches and 0 NULL target_ids.
--
-- Postgres cannot compute UUIDv5 here: it needs SHA-1, which core Postgres lacks
-- (sha224..sha512 only), and neither pgcrypto nor uuid-ossp is installed. Rather
-- than CREATE EXTENSION on production, the 127 ids are precomputed with the rule
-- above and carried in the id_map CTE below. anomalie_1 stays the authoritative
-- source for every other column. To regenerate:
--   python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, '<target_id>'))"
--
-- ======================= TARGET_ID FORMAT (3 DECIMALS) ====================
-- Existing convention is f"{project_id}-{easting:.3f}-{northing:.3f}".
-- anomalie_1 stores 2-decimal easting/northing, so target_id is rendered here as
-- ROUND(<col>::numeric, 3)::text - numeric keeps the scale, giving the trailing
-- zero (359019.290) that matches the existing rows. Verified: this SQL rendering
-- equals Python's .3f for all 127 rows. anomalie_1 itself is left untouched.
--
-- ====================== CONSTRAINTS CHECKED (READ-ONLY) ===================
-- public.anomalies
--   PK      anomalies_pkey (id)
--   FK      anomalies_project_id_fkey (project_id) -> projects(project_id) CASCADE
--   UNIQUE  ix_anomalies_target_id (target_id)   [a unique INDEX, not a constraint]
--   NOT NULL id, project_id, instrument, easting, northing   (no CHECKs, no defaults)
--   TRIGGER trigger_sync_anomaly_geom_coordinates BEFORE INSERT OR UPDATE
-- public.feedback
--   FK      feedback_anomaly_id_fkey (anomaly_id) -> anomalies(id) CASCADE
--   Nothing joins on target_id; feedback.target_id is a denormalised copy. The
--   uuid5 rule is therefore what keeps the new rows linkable by feedback.
-- Nothing is dropped, disabled or altered by this script.
--
-- NOTE: the BEFORE INSERT trigger overwrites the latitude/longitude supplied
-- here. With geom NULL and easting/northing present its Case 2 fires and derives
-- lat/lon from SRID 32632, while anomalie_1 computed them from 25832. Measured
-- divergence max 0.0069 m / avg 0.0035 m. This is intentional - it makes the new
-- rows consistent with how every existing row obtained its lat/lon.
--
-- ========================= COLLISION PRE-FLIGHT ===========================
-- anomalie_1 127 rows vs public.anomalies 1583 rows, using the 3-decimal ids:
--   target_id collisions with public.anomalies : 0
--   id        collisions with public.anomalies : 0
--   internal duplicate target_id / id          : 0 / 0
--   target_id longer than varchar(100)         : 0
--   NOT NULL columns unpopulated by anomalie_1 : 0
-- ON CONFLICT DO NOTHING on both inserts keeps a re-run a no-op.

BEGIN;

-- 1. Parent row first: anomalies.project_id FKs to projects.project_id.
INSERT INTO public.projects (project_id, project_name, created_at, updated_at)
VALUES ('11-26-5151', 'Koeln Deutzerfeld', now(), now())
ON CONFLICT (project_id) DO NOTHING;

-- 2. The 127 anomalies. id comes from the proven rule; every other column from
--    anomalie_1. geom is left out so the trigger derives it from easting/northing.
WITH id_map(target_id, id) AS (VALUES
    ('11-26-5151-359015.430-5645457.080', '8ff48c42-c1a8-5f8a-85c1-7f14ef1a06ea'),
    ('11-26-5151-359016.350-5645455.610', '67375f90-a4e8-54fd-9fc5-dcd05633bb37'),
    ('11-26-5151-359019.290-5645464.340', 'e4c31b99-f3cd-5f5a-b7bc-7099832b1168'),
    ('11-26-5151-359021.460-5645473.330', '525054d1-0a26-52e4-8678-0c9edbbf62e8'),
    ('11-26-5151-359022.140-5645470.640', '3e40ef15-2f57-5424-a9f6-1a6761c743b2'),
    ('11-26-5151-359023.720-5645479.990', '38a97bd6-c4be-5439-9105-39bb98f3d49e'),
    ('11-26-5151-359027.060-5645481.020', '417d68b7-da87-5020-abdd-9b045b9fbb81'),
    ('11-26-5151-359027.950-5645489.870', '214bdc2c-a852-502d-b62a-079b4fef9d06'),
    ('11-26-5151-359030.570-5645493.120', '380f3b23-8523-5b4b-9600-fa0536dc841a'),
    ('11-26-5151-359030.880-5645501.120', '7583ab8d-686d-5a75-901c-5144a363825d'),
    ('11-26-5151-359031.590-5645500.730', 'cea70605-4afe-5ffe-bffa-f99461eac55b'),
    ('11-26-5151-359034.120-5645503.570', '9c1583bd-15e7-5a67-85fe-009dee8728a8'),
    ('11-26-5151-359038.590-5645522.420', '491957aa-c8df-511f-aacc-82eafdd3f197'),
    ('11-26-5151-359039.500-5645520.590', 'b420e267-37a6-5b83-a8b4-458e847ddfbd'),
    ('11-26-5151-359041.300-5645529.630', '095b30e7-340c-583a-a4bc-33a20f3f0a0d'),
    ('11-26-5151-359041.550-5645530.580', 'd115606c-c2ab-56e3-b452-fb5ee82d8c34'),
    ('11-26-5151-359043.020-5645539.380', '0c53a325-56f4-57bf-bafd-3735753ca35f'),
    ('11-26-5151-359045.080-5645553.240', '9fe8c47d-0a0f-5eaf-b6df-eefc73d36d25'),
    ('11-26-5151-359045.900-5645547.250', '6d5bd9c4-a9b9-5298-8a73-6d5d1e309223'),
    ('11-26-5151-359048.360-5645559.740', 'b0952417-c83b-5c1e-a234-8693dcd2780d'),
    ('11-26-5151-359049.340-5645563.590', '17c35fce-2263-55c8-b0de-55733e89cc5a'),
    ('11-26-5151-359051.150-5645576.300', '4871978c-9209-5e55-92fa-125fb87eabd3'),
    ('11-26-5151-359052.170-5645577.090', '5fd908fe-34c3-5b0a-bd20-ad6d03ecb3b2'),
    ('11-26-5151-359052.660-5645573.000', '00541c6b-11f5-5223-a9c3-4749c717620b'),
    ('11-26-5151-359053.580-5645585.620', 'da09c586-fb50-5d1b-bbb0-1e587cf9b860'),
    ('11-26-5151-359054.610-5645586.420', '89546e63-97dd-51e3-801b-81cd98b7fcd7'),
    ('11-26-5151-359054.760-5645584.120', '21bf711f-b836-5014-aad8-60617e332351'),
    ('11-26-5151-359055.020-5645593.280', '1adf36b3-d861-5b7d-8b56-6e5e047653ff'),
    ('11-26-5151-359055.280-5645588.990', '01996686-c0d2-5536-84aa-d47e77688424'),
    ('11-26-5151-359055.590-5645584.120', '247f3000-f91a-5a90-a90d-5b1c1c4bfab7'),
    ('11-26-5151-359055.610-5645595.630', 'e9becf30-412d-5934-be9d-2df17755a551'),
    ('11-26-5151-359055.670-5645595.860', 'ea581e7d-9e58-572c-8920-ba493804801c'),
    ('11-26-5151-359055.840-5645594.270', 'e61ec794-0000-5041-b68b-4e916d41aeaf'),
    ('11-26-5151-359056.130-5645586.200', '25c599f3-31a2-5833-b01c-25bb14621e08'),
    ('11-26-5151-359057.420-5645602.530', 'ac7a5981-e214-5d00-97ee-e351b2767594'),
    ('11-26-5151-359057.980-5645602.490', 'dacffa39-5648-5482-a11e-be3205da310f'),
    ('11-26-5151-359059.000-5645608.580', '68b2059a-76fd-5dcb-a4be-da07c980bc14'),
    ('11-26-5151-359059.570-5645602.560', 'cd79ba69-e550-5eea-9ec3-f86299b17598'),
    ('11-26-5151-359059.650-5645608.870', 'e39c6cc9-d7be-51f6-8c42-df8650698432'),
    ('11-26-5151-359059.880-5645598.420', '881d86dc-a0e5-570c-bb68-69b5fc695c2c'),
    ('11-26-5151-359062.940-5645621.330', '7d50c28c-b1d9-5bdb-af8d-e6d219b569c8'),
    ('11-26-5151-359063.020-5645612.580', 'ffd4a231-6122-5172-bd78-fb8f2f77a1ad'),
    ('11-26-5151-359063.660-5645620.950', '6ee9d1a1-eddd-546b-90a0-cd20728a2814'),
    ('11-26-5151-359063.770-5645624.450', '7ffad540-6291-542f-b304-1e98f73d73c7'),
    ('11-26-5151-359064.330-5645626.530', 'f3a51e2d-8842-5d46-b014-023d7a039802'),
    ('11-26-5151-359064.850-5645628.470', '480a2d54-e0bc-5fb1-a09b-af9168d43135'),
    ('11-26-5151-359065.140-5645623.770', '5e1276f2-5bc0-57d5-b58b-3eeb27a6445d'),
    ('11-26-5151-359066.080-5645622.010', '41340fef-2603-52de-85eb-8f542e19f7ea'),
    ('11-26-5151-359066.230-5645633.750', '4f0b34d2-2828-5bbb-9c25-6df277177ca7'),
    ('11-26-5151-359066.750-5645635.730', 'd09be7dc-2e79-512a-be07-47142ead6868'),
    ('11-26-5151-359067.430-5645629.210', '36fd7b54-321d-52af-b28a-1500ab6292bc'),
    ('11-26-5151-359067.680-5645633.310', 'bf8c3462-1fe2-5d76-b618-71e55b6a9f1e'),
    ('11-26-5151-359067.930-5645637.100', 'a7544b6d-dfe8-54bf-b8df-6b01b0552eb0'),
    ('11-26-5151-359068.520-5645633.380', '4b7b1d70-6712-5035-81ca-60b49afa2ad0'),
    ('11-26-5151-359068.550-5645631.310', '4660698d-bfdf-5461-b74f-69ee6cb18f08'),
    ('11-26-5151-359069.950-5645644.890', '1cec1edf-0358-5d59-826b-c96bcfb10ce0'),
    ('11-26-5151-359070.060-5645637.160', '5374c527-9d7e-59b0-a10e-480e639cd41d'),
    ('11-26-5151-359070.780-5645639.980', '05f5e5e9-e2be-5e84-9792-fd425a4f9be1'),
    ('11-26-5151-359070.830-5645648.310', 'a999d115-0607-5bc6-b78e-d4ca784001b3'),
    ('11-26-5151-359073.880-5645663.230', '4a926878-443c-5711-ae83-001a839e11d5'),
    ('11-26-5151-359073.980-5645657.660', '1ad86220-6f3d-5ae7-a69c-4f6af449a398'),
    ('11-26-5151-359074.660-5645663.030', 'ca045035-5f1d-54cd-b878-3e0eab528755'),
    ('11-26-5151-359074.800-5645657.630', 'cffb4a90-77a3-5686-bb20-f8a180dc5042'),
    ('11-26-5151-359074.850-5645669.040', 'd807f5d4-29e1-5922-97f9-8b80e23c067a'),
    ('11-26-5151-359075.700-5645672.360', 'e7061aa3-4a53-53e5-b650-b249db8726ca'),
    ('11-26-5151-359076.150-5645668.690', 'ec895a9c-ba8d-5329-ae2d-8b7f02b62b35'),
    ('11-26-5151-359076.320-5645672.540', '2c5f9c65-2637-5179-bab5-37a947aa14db'),
    ('11-26-5151-359076.660-5645664.730', 'f8c771ee-54c1-512d-beb2-764ac9601dea'),
    ('11-26-5151-359076.690-5645664.830', '5f81e956-166f-5c6c-9e50-8a7e371aa5f1'),
    ('11-26-5151-359076.750-5645676.320', '1d98aa69-4988-5188-81a7-f7b91915e2bd'),
    ('11-26-5151-359077.080-5645664.180', '2b317fcc-8a0d-543a-a71f-abe4341f18f4'),
    ('11-26-5151-359078.670-5645683.750', 'ac390679-1db4-58cd-822c-bfa086dfe191'),
    ('11-26-5151-359080.270-5645687.690', '3a2805b5-2872-5123-9979-e062e3bd8ea3'),
    ('11-26-5151-359080.610-5645691.050', '870a9cdc-de87-59ef-81ea-f5eabb4aed9c'),
    ('11-26-5151-359080.940-5645690.150', 'baa42523-598c-5464-b822-ea7aa7fc5b3f'),
    ('11-26-5151-359082.970-5645700.190', 'b4331a7c-d0cd-5220-84af-b37221c3ed59'),
    ('11-26-5151-359083.290-5645699.240', '1f592409-17f5-5297-8cf8-7f0ec390b0f1'),
    ('11-26-5151-359083.320-5645696.090', '2579e4dc-ff9d-59fa-a010-bf69b40b185c'),
    ('11-26-5151-359083.550-5645696.970', '7ea647ac-4e92-57d3-814b-d661382540e9'),
    ('11-26-5151-359083.710-5645697.610', '4ba80644-db35-5a2a-afd6-6aab82a780d0'),
    ('11-26-5151-359084.210-5645698.320', '5105372a-dbd0-5d79-a5c8-a33cda3cbedc'),
    ('11-26-5151-359084.600-5645692.850', '053ff292-de96-5707-822b-da27bd74da86'),
    ('11-26-5151-359084.930-5645696.450', '139602d3-926a-5e08-af2e-5bc47a3b31de'),
    ('11-26-5151-359085.890-5645697.810', '7cc61b69-468c-55ce-b0b5-e31524719065'),
    ('11-26-5151-359086.110-5645710.120', 'a85f8e1e-9774-5a56-a34e-4e8c115e76c1'),
    ('11-26-5151-359086.480-5645705.450', '1d6c9003-0bb8-577d-96c6-0c77148d9621'),
    ('11-26-5151-359089.420-5645722.440', '4674d5b0-90b0-5a34-b12f-8bfc69c6c3c9'),
    ('11-26-5151-359089.530-5645720.030', '12093ce3-31c3-5e3f-9b3e-d218b2637b03'),
    ('11-26-5151-359089.970-5645713.060', '79379f6f-b39a-51e6-a63c-e2869f6e5d40'),
    ('11-26-5151-359092.170-5645726.600', 'accee5c5-1776-5097-b696-352c6a673f42'),
    ('11-26-5151-359096.610-5645737.760', 'e4ff95ea-bcff-56cb-9e11-6eac6502acd7'),
    ('11-26-5151-359100.600-5645760.300', 'e460985f-dff2-5f6e-82a5-544c45cfda7c'),
    ('11-26-5151-359101.070-5645754.010', '360325fc-ec7e-5493-be85-7380e0e5e716'),
    ('11-26-5151-359101.570-5645759.060', 'c1dcc65e-4bdf-5de4-b52c-4b4050b25a51'),
    ('11-26-5151-359101.800-5645756.980', '3ce509ec-58a4-5027-addd-a8acd9e38a91'),
    ('11-26-5151-359103.650-5645772.530', '4580ca59-ecad-57b6-adad-a8597c075397'),
    ('11-26-5151-359111.190-5645803.260', 'cd0c1c3b-ea33-5992-b80e-43f2615efc1d'),
    ('11-26-5151-359111.830-5645805.420', 'e7c0ada7-c8c5-5d0f-9c45-4a8d60920027'),
    ('11-26-5151-359112.140-5645804.500', 'cb646747-411e-51a1-b91d-b6273ae9c453'),
    ('11-26-5151-359112.390-5645800.000', 'dfc1f2bc-f5de-5273-a8dc-26c101fdc1ef'),
    ('11-26-5151-359112.950-5645809.150', '0819b619-b282-5afb-a433-af0d05f30487'),
    ('11-26-5151-359113.290-5645808.380', 'b45959b6-344e-5acd-bab3-676f1a5b065d'),
    ('11-26-5151-359115.310-5645809.820', '13b190a9-1e65-5a3b-af76-5c0c3fd8c9db'),
    ('11-26-5151-359116.040-5645807.550', '9c6a5d85-9d5c-502b-8fb5-b22c2bc759c6'),
    ('11-26-5151-359116.170-5645812.660', '80d370b2-2463-5f19-8421-171559cbc06c'),
    ('11-26-5151-359119.150-5645829.780', '1e08ae3e-bac5-505c-83a4-df203d5dbad2'),
    ('11-26-5151-359119.220-5645829.860', '9d3544f0-6ff5-59e3-9f59-4560af752c99'),
    ('11-26-5151-359120.560-5645834.570', '3d69d6b0-67fd-5893-b80f-06311df3bf1d'),
    ('11-26-5151-359120.820-5645833.490', 'ed3e1d5f-f1a2-5a4b-baeb-5d1f66c51c63'),
    ('11-26-5151-359121.430-5645837.540', '7183d247-3e90-51fc-b958-153bd977730b'),
    ('11-26-5151-359122.150-5645837.990', '96e3837e-159c-5dd3-8ae8-bcb6b6d5a8a6'),
    ('11-26-5151-359122.280-5645828.290', '2281725e-335a-5038-8f7d-8f06d531913b'),
    ('11-26-5151-359122.660-5645841.740', 'c69e8c7a-ea4f-5e46-8ffe-a1b1a0a2dde9'),
    ('11-26-5151-359123.180-5645841.550', '99a09695-f82c-5a7b-89ff-7e68da50212c'),
    ('11-26-5151-359123.710-5645840.530', '120d8b26-8a96-52fa-9d3e-0311e0193478'),
    ('11-26-5151-359123.730-5645840.590', '7039a673-1d85-5da6-8760-04f3c409e552'),
    ('11-26-5151-359124.420-5645840.310', '1e135d0f-7aec-54ec-8d5b-31dfbcd61452'),
    ('11-26-5151-359124.480-5645846.160', '77a918b3-3d74-50ae-8b8b-448a5e8d4ca2'),
    ('11-26-5151-359124.550-5645843.480', '2a5d2e64-276b-59b8-b84d-4e6cf6c805bc'),
    ('11-26-5151-359124.590-5645848.170', '1214a395-fc57-55d1-80ad-2b1f0b29e385'),
    ('11-26-5151-359124.830-5645849.420', 'e0d9e39c-200c-5a0a-a459-23dce064c927'),
    ('11-26-5151-359124.960-5645849.910', '8ab7921f-30e9-53f4-8fd7-193b86cfcf2a'),
    ('11-26-5151-359124.970-5645849.950', '1491d988-88f4-5b7e-a82d-aabcedde6228'),
    ('11-26-5151-359125.080-5645850.360', 'd2eb85fb-0a9d-5d26-a277-c6d3f9cf1e23'),
    ('11-26-5151-359125.150-5645848.180', '120f4f73-3e94-5e98-8fd7-e9b7d0ab050d'),
    ('11-26-5151-359126.610-5645848.470', '8c9cd5cc-ded1-5fd0-ada9-347067dc63f3'),
    ('11-26-5151-359126.620-5645848.440', 'f54e8a58-c0b4-5aa2-9481-cb0b8eb3871f')
)
INSERT INTO public.anomalies
    (id, project_id, instrument, easting, northing, latitude, longitude,
     vm_nr, category, layer, status, target_id, evaluated_depth)
SELECT
    m.id,
    a.project_id,
    a.instrument,
    a.easting,
    a.northing,
    a.latitude,
    a.longitude,
    a.vm_nr,
    a.category,
    a.layer,
    a.status,
    m.target_id,
    a.evaluated_depth
FROM p_11_26_5151_koeln_deutzerfeld.anomalie_1 AS a
JOIN id_map AS m
  ON m.target_id = '11-26-5151-' || ROUND(a.easting::numeric,3)::text
                                 || '-' || ROUND(a.northing::numeric,3)::text
ON CONFLICT (id) DO NOTHING;

-- 3. In-transaction gates. Any failure raises and the whole transaction rolls
--    back, so production is never left half-applied.
DO $$
DECLARE
    n_project   int;
    n_appended  int;
    n_source    int;
    n_badid     int;
    n_orphan    int;
BEGIN
    SELECT count(*) INTO n_project  FROM public.projects  WHERE project_id = '11-26-5151';
    SELECT count(*) INTO n_appended FROM public.anomalies WHERE project_id = '11-26-5151';
    SELECT count(*) INTO n_source   FROM p_11_26_5151_koeln_deutzerfeld.anomalie_1;

    IF n_project <> 1 THEN
        RAISE EXCEPTION 'GATE 1 FAILED: expected exactly 1 projects row for 11-26-5151, found %', n_project;
    END IF;
    IF n_appended <> n_source THEN
        RAISE EXCEPTION 'GATE 2 FAILED: appended % anomalies but anomalie_1 holds %', n_appended, n_source;
    END IF;

    -- target_id must still be the string the id was hashed from.
    SELECT count(*) INTO n_badid FROM public.anomalies
     WHERE project_id = '11-26-5151'
       AND target_id <> '11-26-5151-' || ROUND(easting::numeric,3)::text
                                      || '-' || ROUND(northing::numeric,3)::text;
    IF n_badid > 0 THEN
        RAISE EXCEPTION 'GATE 3 FAILED: % rows whose target_id does not match their coordinates', n_badid;
    END IF;

    -- No feedback row may point at a missing anomaly.
    SELECT count(*) INTO n_orphan FROM public.feedback f
     LEFT JOIN public.anomalies a ON a.id = f.anomaly_id WHERE a.id IS NULL;
    IF n_orphan > 0 THEN
        RAISE EXCEPTION 'GATE 4 FAILED: % orphaned feedback rows', n_orphan;
    END IF;

    RAISE NOTICE 'All gates passed: projects=%, anomalies appended=%, source=%', n_project, n_appended, n_source;
END $$;

COMMIT;
