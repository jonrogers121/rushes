# Security Specification: Rushes

## Data Invariants
1. A project must have an `ownerId` matching the creator's `request.auth.uid`.
2. Only the project owner can read, update, or delete the project.
3. Access to videoFiles and sourceFiles is restricted to the owner of the parent project.
4. Document IDs must be alphanumeric and under 128 characters.
5. All timestamps must be server-generated (`request.time`).
6. Names and descriptions have strict size limits.

## The Dirty Dozen Payloads

1. **Identity Spoofing**: Attempt to create a project with an `ownerId` that is not the sender's UID.
2. **Relational Bypass**: Attempt to create a file in a project that the user does not own.
3. **Orphaned Write**: Attempt to create a file for a `projectId` that does not exist.
4. **ID Poisoning**: Attempt to create a document with a 2KB junk character string as a document ID.
5. **PII Leak**: Attempt to list projects when not signed in.
6. **State Shortcut**: Attempt to update a project's `createdAt` timestamp (it should be immutable).
7. **Resource Exhaustion**: Attempt to write a name field that is 1MB in size.
8. **Shadow Field Injection**: Attempt to inject `isVerified: true` into a project document.
9. **Update Gap**: Attempt to update a project and remove the `ownerId` field.
10. **Query Scraping**: Attempt to list all projects in the database without a filter on personal `ownerId`.
11. **Email Spoofing**: (If used in rules) Attempt to access data via an unverified email.
12. **Cross-Project Access**: Attempt to read a file metadata document from a project owned by another user.
