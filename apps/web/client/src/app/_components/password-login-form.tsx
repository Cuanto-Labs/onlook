'use client';

import { Button } from '@onlook/ui/button';
import { Input } from '@onlook/ui/input';
import { useActionState } from 'react';
import { passwordLogin } from '../login/actions';

export const PasswordLoginForm = () => {
    const [state, formAction, isPending] = useActionState(passwordLogin, { error: null });

    return (
        <form action={formAction} className="flex flex-col space-y-2">
            <Input name="email" type="email" autoComplete="email" placeholder="Email" required />
            <Input
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                required
            />
            {state.error && <p className="text-small text-red-400">{state.error}</p>}
            <Button type="submit" disabled={isPending} className="w-full">
                {isPending ? 'Signing in...' : 'Sign in'}
            </Button>
        </form>
    );
};
