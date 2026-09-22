using DicsV2.DocumentService.Data;
using DicsV2.DocumentService.Merkle;
using DicsV2.DocumentService.Services;
using DicsV2.DocumentService.Storage;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Minimal APIs (no separate Controller classes) are ASP.NET Core's
// newer, lighter-weight style — functionally equivalent to a
// Spring @RestController or a FastAPI router, just a different
// syntactic convention this framework favors as of .NET 6+.
var storageRoot = Environment.GetEnvironmentVariable("STORAGE_ROOT") ?? "/data/documents";
var dbPath = Environment.GetEnvironmentVariable("DATABASE_PATH") ?? "/data/documents.db";

builder.Services.AddDbContext<DocumentDbContext>(options =>
    options.UseSqlite($"Data Source={dbPath}"));
builder.Services.AddSingleton<IDocumentStorage>(new LocalFileStorage(storageRoot));
builder.Services.AddSingleton<MerkleTreeService>();
builder.Services.AddScoped<DocumentUploadService>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    // EnsureCreated, not a real migration pipeline — a deliberate
    // simplification for a service this small; a production version
    // would want EF Core Migrations for real schema evolution over
    // time, the same way the backend uses Alembic.
    var db = scope.ServiceProvider.GetRequiredService<DocumentDbContext>();
    db.Database.EnsureCreated();
}

app.MapPost("/claims/{claimId:long}/documents", async (
    long claimId,
    IFormFile file,
    DocumentUploadService uploadService,
    CancellationToken ct) =>
{
    // The HTTP layer's whole job here: pull the bytes out of the
    // multipart request, hand them to DocumentUploadService, translate
    // its result (or its thrown exception) into an HTTP response.
    // Nothing about hashing, storage, or the database happens in this
    // lambda itself anymore.
    await using var memoryStream = new MemoryStream();
    await file.CopyToAsync(memoryStream, ct);

    try
    {
        var document = await uploadService.UploadAsync(
            claimId, file.FileName, file.ContentType, memoryStream.ToArray(), ct);

        return Results.Created($"/claims/{claimId}/documents/{document.Id}", new
        {
            document.Id,
            document.FileName,
            document.KeccakHash,
            document.SizeBytes,
            document.UploadedAt,
        });
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { detail = ex.Message });
    }
});

app.MapGet("/claims/{claimId:long}/documents", async (long claimId, DocumentDbContext db, CancellationToken ct) =>
{
    var documents = await db.Documents
        .Where(d => d.ClaimId == claimId)
        .OrderBy(d => d.UploadedAt)
        .Select(d => new { d.Id, d.FileName, d.KeccakHash, d.SizeBytes, d.UploadedAt })
        .ToListAsync(ct);

    return Results.Ok(documents);
});

app.MapGet("/claims/{claimId:long}/merkle-root", async (
    long claimId,
    DocumentDbContext db,
    MerkleTreeService merkle,
    CancellationToken ct) =>
{
    var hashHexValues = await db.Documents
        .Where(d => d.ClaimId == claimId)
        .Select(d => d.KeccakHash)
        .ToListAsync(ct);

    if (hashHexValues.Count == 0)
    {
        return Results.NotFound(new { detail = $"No documents uploaded for claim {claimId}." });
    }

    var leaves = hashHexValues
        .Select(hex => Convert.FromHexString(hex.Replace("0x", "")))
        .ToList();

    var root = merkle.ComputeRoot(leaves);

    return Results.Ok(new
    {
        claimId,
        documentCount = leaves.Count,
        merkleRoot = MerkleTreeService.ToHex(root),
    });
});

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.Run();

// Exposes Program as a public partial class, purely so
// WebApplicationFactory<Program> can find it from the test project —
// top-level statement Program.cs files are implicitly `internal`
// without this, which would block the integration test project (a
// separate assembly) from referencing this one at all.
public partial class Program { }
