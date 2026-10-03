-- Removes tickets submitted during rehearsals and clears every reply. Run on the Customer DB.
delete from support_tickets where id > 3;
update support_tickets set reply = null;
