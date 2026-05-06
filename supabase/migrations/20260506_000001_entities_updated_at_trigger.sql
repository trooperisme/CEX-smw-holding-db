create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_entities_updated_at on public.entities;

create trigger trg_entities_updated_at
before update on public.entities
for each row
execute function public.set_updated_at();
