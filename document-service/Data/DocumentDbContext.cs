using DicsV2.DocumentService.Models;
using Microsoft.EntityFrameworkCore;

namespace DicsV2.DocumentService.Data;

/// <summary>
/// SQLite, not the shared Postgres the other services use — a
/// deliberate choice, not an oversight. This service's data (document
/// metadata) has no reason to live in the same database as the
/// backend's claims or the indexer's on-chain mirror; giving it its own
/// self-contained file avoids adding a new schema to a shared
/// Postgres instance that two other services already have their own
/// ownership boundaries around (see the Go and Java services' own
/// comments on that exact issue). A real production version handling
/// real file volumes would likely want Postgres too, plus real object
/// storage instead of local disk (see LocalFileStorage) — named here as
/// a genuine scope simplification, not hidden.
/// </summary>
public class DocumentDbContext : DbContext
{
    public DocumentDbContext(DbContextOptions<DocumentDbContext> options) : base(options) { }

    public DbSet<ClaimDocument> Documents => Set<ClaimDocument>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<ClaimDocument>(entity =>
        {
            entity.HasKey(d => d.Id);
            entity.HasIndex(d => d.ClaimId); // every query in this service filters by claim ID
        });
    }
}
