alter table trips add column if not exists arrival_airport text;
alter table trips add column if not exists flight_arrival_time text;
alter table trips add column if not exists city_transfer_modes jsonb default '{}';
